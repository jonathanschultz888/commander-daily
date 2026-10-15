/**
 * Engine driver: advances the game through steps, priority, the stack and combat,
 * pausing only when the human actually has something to do.
 *
 * Design choice that keeps play smooth: the human is *not* asked to pass priority
 * for no reason. They get a window when it's their main phase, or when the opponent
 * puts something on the stack and the human holds a legal response. Everything else
 * auto-passes, which is how digital clients behave and what makes a mobile game
 * playable with one hand.
 */
import { characteristics, hasKeyword, isLand } from './cards.js';
import { damage, findPermanent, pump, grantKeyword, sacrifice, permValue } from './ops.js';
import { makeBot, canBlock } from './bot.js';
import { chooseTarget } from './targeting.js';
import { cardScript } from './scripts.js';

export const COMBAT_STEPS = ['declareAttackers', 'declareBlockers', 'combatDamage'];

export function runEngine(game, opts = {}) {
  const options = { stopForHuman: true, maxIterations: 6000, ...opts };
  const bot = game.bot || makeBot(game.players[1]?.deck?.prototype || 'midrange');
  let guard = 0;

  while (guard++ < options.maxIterations) {
    if (game.status === 'over') return { status: 'over', result: game.result };
    if (options.stopWhen && options.stopWhen(game)) return { status: 'handover' };
    const stepName = game.step || 'untap';

    if (stepName === 'untap' || stepName === 'cleanup') {
      game.advanceStep();
      continue;
    }
    if (stepName === 'declareAttackers') {
      const res = declareAttackers(game, bot, options);
      if (res === 'awaiting') return { status: 'awaiting' };
      if (game.status === 'over') return { status: 'over', result: game.result };
      game.stepIndex++; game.enterStep();
      continue;
    }
    if (stepName === 'declareBlockers') {
      const res = declareBlockers(game, bot, options);
      if (res === 'awaiting') return { status: 'awaiting' };
      if (game.status === 'over') return { status: 'over', result: game.result };
      game.stepIndex++; game.enterStep();
      continue;
    }
    if (stepName === 'combatDamage') {
      combatDamage(game);
      if (game.status === 'over') return { status: 'over', result: game.result };
      game.stepIndex++; game.enterStep();
      continue;
    }

    // Non-combat step: run priority rounds until everyone passes
    const res = priorityWindow(game, bot, options);
    if (res === 'awaiting') return { status: 'awaiting' };
    if (game.status === 'over') return { status: 'over', result: game.result };
    if (game.stack.length) continue;
    game.advanceStep();
  }
  return { status: 'stalled' };
}

/* ------------------------------------------------------------------ */
/* Priority                                                            */
/* ------------------------------------------------------------------ */

/**
 * Can this action be taken while someone else holds priority? (CR 117.1a: the
 * active player gets priority in their own main phase; anyone may respond with
 * an instant, a flash card, or any activated ability not restricted to sorcery
 * timing.) Mana abilities never appear in legalActions — they are automatic.
 */
function isInstantSpeedAction(game, pid, a) {
  if (a.type === 'activate') {
    // Activated abilities are instant-speed unless the card says otherwise; none
    // of the pool's abilities carry a sorcery-timing restriction.
    return true;
  }
  if (a.type !== 'cast') return false;
  const card = findCardInZones(game, pid, a.iid);
  if (!card) return false;
  return card.types.includes('Instant') || card.keywords.has('Flash') || card.types.includes('Flash');
}

/** Say once per step why the game moved on without asking anything. */
function noteNoPlay(game, stepName) {
  const log = game.autoPassLog || (game.autoPassLog = {});
  const key = `${game.turn}:${stepName}`;
  if (log[key]) return;
  log[key] = true;
  const nice = { main1: 'your first main phase', main2: 'your second main phase', upkeep: 'your upkeep', draw: 'your draw step', combat: 'your combat step', declareAttackers: 'your attack step' }[stepName] || `your ${stepName} step`;
  game.log(`Nothing you can legally do in ${nice} — skipped.`);
}

function priorityWindow(game, bot, options) {
  const st = game.priorityState || (game.priorityState = { passed: [] });
  if (!Array.isArray(st.passed)) st.passed = [];
  const isHumanTurnPhase = () => ['main1', 'main2'].includes(game.step) && game.activePlayer === game.humanId;
  let safety = 0;

  while (safety++ < 60) {
    if (game.status === 'over') return 'over';
    game.flushTriggers();

    const pid = game.priority;
    const humanSeat = pid === game.humanId && !game.humanIsBot;
    const alreadyPassed = st.passed.includes(pid);
    const actions = game.legalActions(pid);

    // Give the human a window only when they can meaningfully act and haven't passed.
    // `pass` is *always* legal, so it must never count as a reason to stop: a prompt
    // whose only button is "pass priority" is not a decision, it is a delay. The
    // rules check is therefore "does this player hold a legal action at all" first,
    // and only then "is this a moment where such an action is worth offering".
    const meaningful = actions.filter((a) => a.type !== 'pass');
    if (humanSeat && options.stopForHuman && !alreadyPassed) {
      const opponentActing = game.stack.some((s) => s.controller !== game.humanId);
      const canRespond = meaningful.some((a) => isInstantSpeedAction(game, pid, a));
      const shouldStop = meaningful.length > 0 && (
        isHumanTurnPhase()                             // their own main phase: land drop, cast, activate
        || (game.stack.length > 0 && canRespond)       // something on the stack they could answer
        || (opponentActing && canRespond)              // opponent is acting and they can react
      );
      if (shouldStop) {
        game.pending = { type: 'priority', player: pid, actions };
        return 'awaiting';
      }
      // Nothing legal for them here: skip the window entirely (no prompt, no
      // validation) and say so on their own turn so a quiet turn doesn't read
      // as a bug. Once per step — the log is not a turn-by-turn transcript.
      if (game.activePlayer === game.humanId) noteNoPlay(game, game.step);
    }

    // Bot (or the human seat during the scripted opening) acts
    const chosen = bot.chooseAction(game, pid);
    if (chosen) {
      const executed = executeAction(game, bot, pid, chosen.action);
      if (executed) {
        st.passed = [];               // someone acted: priority restarts
        game.priority = pid;
        continue;
      }
    }

    // Pass priority (CR 117.3d / 117.4)
    if (!alreadyPassed) st.passed.push(pid);
    if (st.passed.length >= 2) {
      if (game.stack.length) {
        game.resolveTop();
        st.passed = [];
        game.priority = game.activePlayer;
        continue;
      }
      return 'stepDone';
    }
    game.priority = game.other(pid);
  }
  return 'stepDone';
}

/**
 * The opening: both seats are played by the bot for a few turns, then the human
 * inherits one of them at a pivotal point.
 *
 * "Pivotal" is enforced rather than hoped for: some shuffles leave the player
 * holding nothing castable, and a turn whose only legal move is "pass" is not a
 * puzzle. So if the inherited prompt has fewer than two options, the bot keeps
 * playing the seat — deterministically, same seed, so the run is identical for
 * every player — until a turn arrives with a real decision in it. Bounded, so an
 * unusually clunky draw can't stall the run.
 */
export function playOpening(game, { graceTurns = 8 } = {}) {
  const human = game.humanId;
  const takeoverAt = game.takeoverAt || 4;

  /** How much of a decision the player would actually have right now. */
  const choicesNow = (g) => {
    try {
      const acts = g.legalActions(human).filter((a) => a.type !== 'pass');
      const meaningful = acts.some((a) => ['cast', 'activate', 'playLand', 'attackers'].includes(a.type));
      return meaningful ? acts.length : 0;
    } catch { return 0; }
  };
  const inHumanMain = (g, minTurn) => g.turnNumberFor?.[human] >= minTurn
    && g.activePlayer === human && ['main1', 'main2'].includes(g.step);

  // Play the opening with both seats on the bot, stopping at the first of the
  // player's main phases that actually contains a decision. The check happens
  // *at* that window rather than after the fact: stopping and then re-entering
  // the engine used to skip past the main phase and park on a later window where
  // the player often had nothing to do (a land drop already spent, no instants).
  game.humanIsBot = true;
  runEngine(game, {
    stopForHuman: false,
    stopWhen: (g) => inHumanMain(g, takeoverAt)
      && (choicesNow(g) >= 2 || (g.turnNumberFor?.[human] ?? 0) >= takeoverAt + graceTurns),
  });
  game.openingPlayed = true;
  game.openingDelayed = Math.max(0, (game.turnNumberFor?.[human] ?? takeoverAt) - takeoverAt);

  // Hand the seat over: park on the player's priority window so the client can act.
  game.humanIsBot = false;
  if (game.status === 'playing') runEngine(game, { stopForHuman: true });
  return game;
}

/**
 * The one place a player action is applied to the game — the HTTP handler and
 * anything driving a seat (a bot standing in for the player, a test, the
 * sweep) all come through here, so no path can quietly support fewer actions
 * than another.
 *
 * Pass `bot` to have legal targets and X chosen automatically, which is what a
 * seat under bot control needs; leave it out and the caller must supply targets,
 * which is what a real player does.
 */
export function applyPlayerAction(game, pid, action, { bot = null } = {}) {
  if (!action || typeof action !== 'object') return { error: 'missing action' };
  if (game.status === 'over') return { error: 'game is over' };

  switch (action.type) {
    case 'pass': {
      // Real priority pass (CR 117.3d): record it so the driver can end the step
      // once both players have passed.
      game.pending = null;
      game.priorityState = game.priorityState || { passed: [] };
      if (!game.priorityState.passed.includes(pid)) game.priorityState.passed.push(pid);
      game.priority = game.other(pid);
      return { ok: true };
    }
    case 'concede': {
      game.pending = null;
      game.finish(game.other(pid), { reason: 'conceded' });
      return { ok: true };
    }
    case 'playLand':
    case 'cast': {
      const card = [...game.players[pid].zones.hand, ...game.players[pid].zones.command].find((c) => c.iid === action.iid);
      if (!card) return { error: 'card not in hand' };
      if (isLand(card) && action.type === 'cast') return { error: 'lands are played, not cast' };
      let targets = (action.targets || []).map((t) => resolveTargetRef(game, t));
      let x = action.x || 0;
      // Auto-targeting is for spells. A land is played, not cast, and never has
      // targets to choose — asking the bot for them can fail on a land whose
      // script carries an activated ability with a target.
      if (bot && !targets.length && action.type === 'cast') {
        const filled = bot.withTargets(game, pid, action, card);
        if (!filled) return { error: 'no legal target' };
        targets = filled.targets || [];
        x = pickX(game, card, pid);
      }
      const res = game.cast(pid, card, { targets, x, mode: action.mode });
      if (!res.ok) return { error: res.reason || 'illegal cast' };
      game.pending = null;
      return { ok: true };
    }
    case 'activate': {
      const perm = game.battlefield.find((p) => p.iid === action.iid);
      if (!perm) return { error: 'permanent not found' };
      const script = cardScript(perm);
      const ability = script.abilities[action.index];
      if (!ability) return { error: 'no such ability' };
      let targets = (action.targets || []).map((t) => resolveTargetRef(game, t));
      let x = action.x || 0;
      if (bot && !targets.length) {
        x = pickX(game, perm, pid);
        if (ability.equip !== undefined) {
          const creature = bestEquipTarget(game, pid, perm);
          if (!creature) return { error: 'no creature to equip' };
          targets.push(creature.iid);
        } else if (ability.target) {
          const spec = ability.target === 'creatureYouControl' ? { kind: 'permanent', filter: { creature: true, controller: 'you' } }
            : ability.target === 'creature' ? { kind: 'permanent', filter: { creature: true } }
            : { kind: 'permanent', filter: {} };
          const t = chooseTarget(game, { source: perm, controller: pid }, spec, { mode: 'value' });
          if (t === null) return { error: 'no legal target' };
          targets.push(t);
        }
        x = pickX(game, perm, pid);
      }
      const res = game.activate(pid, perm, ability, { targets, x });
      if (!res.ok) return { error: res.reason || 'illegal activation' };
      game.pending = null;
      return { ok: true };
    }
    case 'attackers': {
      if (game.pending?.type !== 'declareAttackers') return { error: 'not choosing attackers' };
      const legal = new Set(game.pending.legal);
      const chosen = (action.iids || []).filter((i) => legal.has(i));
      applyAttackers(game, chosen);
      return { ok: true };
    }
    case 'blockers': {
      if (game.pending?.type !== 'declareBlockers') return { error: 'not choosing blockers' };
      const legal = game.pending.legal || {};
      const pairs = (action.pairs || []).filter((pr) => (legal[pr.blocker] || []).includes(pr.attacker));
      applyBlockers(game, pairs);
      return { ok: true };
    }
    default:
      return { error: `unknown action ${action.type}` };
  }
}

/** Apply a target reference as sent over HTTP: a number, "player:1", or an iid. */
export function resolveTargetRef(game, ref) {
  if (typeof ref === 'number') return ref;
  if (typeof ref === 'string' && ref.startsWith('player:')) return Number(ref.split(':')[1]);
  if (typeof ref === 'string') return game.battlefield.find((p) => p.iid === ref) || ref;
  return ref;
}

/** Bot convenience wrapper: apply an action, auto-choosing targets and X. */
export function executeAction(game, bot, pid, action) {
  return !!applyPlayerAction(game, pid, action, { bot }).ok;
}

function pickX(game, card, pid) {
  if (!card.parsedCost?.x) return 0;
  const avail = game.manaSources(pid).reduce((a, s) => a + (s.ability.amount || 1), 0);
  const base = card.parsedCost.generic || 0;
  return Math.max(1, Math.min(avail - base, 4));
}

function bestEquipTarget(game, pid, equipment) {
  const creatures = game.creaturesControlledBy(pid).filter((c) => c.iid !== equipment.iid);
  if (!creatures.length) return null;
  creatures.sort((a, b) => {
    const av = characteristics(game, a).power + (a.isCommander ? 3 : 0);
    const bv = characteristics(game, b).power + (b.isCommander ? 3 : 0);
    return bv - av;
  });
  return creatures[0];
}

/* ------------------------------------------------------------------ */
/* Combat                                                              */
/* ------------------------------------------------------------------ */

function declareAttackers(game, bot, options) {
  if (game.attackersDeclared) return 'done';
  const pid = game.activePlayer;
  const humanSeat = pid === game.humanId && !game.humanIsBot;
  const legal = game.creaturesControlledBy(pid).filter((c) =>
    !c.tapped && (!c.summoningSick || hasKeyword(game, c, 'Haste')) && !hasKeyword(game, c, 'Defender') && characteristics(game, c).power > 0);

  if (!legal.length) return 'done';
  if (humanSeat && options.stopForHuman) {
    game.pending = {
      type: 'declareAttackers',
      player: pid,
      legal: legal.map((c) => c.iid),
      suggested: bot.declareAttackers(game, pid),
      defender: game.other(pid),
      defenderLife: game.players[game.other(pid)].life,
    };
    return 'awaiting';
  }
  const attackers = bot.declareAttackers(game, pid);
  game.attackersDeclared = true;
  game.attackers = attackers;
  for (const iid of attackers) {
    const perm = findPermanent(game, iid);
    if (perm) {
      perm.attackedThisTurn = true;
      perm.tapped = true;
      game.emit({ type: 'attacks', card: iid, controller: pid, name: perm.name });
    }
  }
  if (attackers.length) game.log(`${game.players[pid].name} attacks with ${attackers.length} creature(s)`);
  game.checkStateBased();
  return 'done';
}

/** Called by the server when the human submits their attackers. */
export function applyAttackers(game, iids) {
  const pid = game.activePlayer;
  game.attackersDeclared = true;
  game.attackers = iids;
  for (const iid of iids) {
    const perm = findPermanent(game, iid);
    if (!perm) continue;
    perm.attackedThisTurn = true;
    perm.tapped = true;
    game.emit({ type: 'attacks', card: iid, controller: pid, name: perm.name });
  }
  if (iids.length) game.log(`${game.players[pid].name} attacks with ${iids.length} creature(s)`);
  game.pending = null;
  game.checkStateBased();
  return game;
}

function declareBlockers(game, bot, options) {
  if (game.blocksDeclared) return 'done';
  const attackers = (game.attackers || []).map((iid) => findPermanent(game, iid)).filter(Boolean);
  if (!attackers.length) return 'done';
  const defender = game.other(game.activePlayer);
  const humanSeat = defender === game.humanId && !game.humanIsBot;
  const legalBlockers = game.creaturesControlledBy(defender).filter((c) => !c.tapped);
  // An untapped creature is not enough: it must be able to block *something*
  // (a ground creature cannot block a flier, and menace needs two). If nothing
  // can block, there is no decision to make, so no prompt is shown and the
  // empty block resolves through the bot path below.
  const canBlockAnything = legalBlockers.some((b) => attackers.some((a) => canBlock(game, b, a)));

  if (humanSeat && options.stopForHuman && canBlockAnything) {
    const optionsMap = {};
    for (const b of legalBlockers) {
      optionsMap[b.iid] = attackers.filter((a) => canBlock(game, b, a)).map((a) => a.iid);
    }
    game.pending = {
      type: 'declareBlockers',
      player: defender,
      attackers: attackers.map((a) => a.iid),
      blockers: legalBlockers.map((b) => b.iid),
      legal: optionsMap,
      suggested: bot.declareBlocks(game, defender, attackers.map((a) => a.iid)),
    };
    return 'awaiting';
  }
  game.blocksDeclared = true;
  game.blocks = bot.declareBlocks(game, defender, attackers.map((a) => a.iid));
  if (game.blocks.length) game.log(`${game.players[defender].name} blocks ${game.blocks.length} attacker(s)`);
  return 'done';
}

export function applyBlockers(game, pairs) {
  game.blocksDeclared = true;
  game.blocks = pairs;
  game.pending = null;
  return game;
}

export function combatDamage(game) {
  const attackers = (game.attackers || []).map((iid) => findPermanent(game, iid)).filter(Boolean);
  const blocks = game.blocks || [];
  const firstStrikeRound = !game._fsDone;

  const hasFS = (p) => {
    const kws = characteristics(game, p).keywords;
    return kws.has('First strike') || kws.has('Double strike');
  };

  const assign = (round) => {
    for (const atk of attackers) {
      if (atk.leftBattlefield || !game.battlefield.includes(atk)) continue;
      const isFS = hasFS(atk);
      if ((round === 'first' && !isFS) || (round === 'normal' && isFS && !characteristics(game, atk).keywords.has('Double strike'))) {
        if (round === 'normal' && isFS && !characteristics(game, atk).keywords.has('Double strike')) continue;
        if (round === 'first' && !isFS) continue;
      }
      const atkCh = characteristics(game, atk);
      const blockerPairs = blocks.filter((b) => b.attacker === atk.iid);
      const blockers = blockerPairs.map((b) => findPermanent(game, b.blocker)).filter(Boolean);
      if (!blockers.length) {
        // unblocked: damage the defending player
        const target = game.other(atk.controller);
        damage(game, target, atkCh.power, { source: atk, combat: true, round });
        recordCommanderDamage(game, atk, target, atkCh.power);
        game.emit({ type: 'combatDamageToPlayer', source: atk.iid, player: target, amount: atkCh.power, controller: atk.controller });
        continue;
      }
      // Damage assignment (CR 510.1): lethal to each blocker in order, then the
      // rest tramples over — or is absorbed by the last blocker if there's no trample.
      let remaining = atkCh.power;
      const trample = atkCh.keywords.has('Trample');
      const deathtouch = atkCh.keywords.has('Deathtouch');
      const lifelink = atkCh.keywords.has('Lifelink');
      const lethalm = blockers.map((b) => {
        if (deathtouch) return 1;                       // 1 damage is lethal with deathtouch
        const bt = characteristics(game, b).toughness - b.damage;
        return Math.max(0, bt);
      });
      for (let i = 0; i < blockers.length; i++) {
        const b = blockers[i];
        const isLast = i === blockers.length - 1;
        let amount;
        if (trample) amount = Math.min(remaining, lethalm[i]);
        else if (!isLast) amount = Math.min(remaining, lethalm[i]);
        else amount = remaining;                        // no trample: the last blocker soaks the rest
        amount = Math.max(0, Math.min(amount, remaining));
        if (amount > 0) {
          damage(game, b, amount, { source: atk, combat: true, round });
          remaining -= amount;
        }
        game.emit({ type: 'damageToCreature', source: atk.iid, target: b.iid, amount, controller: atk.controller });
      }
      if (remaining > 0 && trample) {
        const target = game.other(atk.controller);
        damage(game, target, remaining, { source: atk, combat: true, round });
        recordCommanderDamage(game, atk, target, remaining);
        game.emit({ type: 'combatDamageToPlayer', source: atk.iid, player: target, amount: remaining, controller: atk.controller });
      }
      // blockers hit back
      for (const b of blockers) {
        if (!game.battlefield.includes(b)) continue;
        const bch = characteristics(game, b);
        const isBFS = bch.keywords.has('First strike') || bch.keywords.has('Double strike');
        if ((round === 'first' && !isBFS) || (round === 'normal' && isBFS && !bch.keywords.has('Double strike'))) continue;
        if (b.damage >= bch.toughness && !bch.keywords.has('Double strike')) continue;
        damage(game, atk, bch.power, { source: b, combat: true, round });
      }
      if (lifelink) game.emit({ type: 'youGainLife', player: atk.controller, amount: 0 });
    }
  };

  const anyFirstStrike = attackers.some(hasFS)
    || (game.blocks || []).some((p) => { const b = findPermanent(game, p.blocker); return b && hasFS(b); });
  if (anyFirstStrike && !game._fsDone) {
    game.log('First strike damage');
    assign('first');
    game.checkStateBased();
    game._fsDone = true;
    if (!game.status === 'over') assign('normal');
    else assign('normal');
  } else {
    assign('normal');
    game._fsDone = false;
  }
  game.checkStateBased();
  // end of combat
  for (const p of game.battlefield) { p.attackedThisTurn = false; }
  game.attackers = [];
  game.blocks = [];
  game.attackersDeclared = false;
  game.blocksDeclared = false;
}

function recordCommanderDamage(game, source, targetPlayerId, amount) {
  if (!source.isCommander) return;
  const pl = game.players[targetPlayerId];
  pl.commanderDamage = pl.commanderDamage || {};
  pl.commanderDamage[source.name] = (pl.commanderDamage[source.name] || 0) + amount;
  game.checkGameEnd();
}

function findCardInZones(game, pid, iid) {
  const pl = game.players[pid];
  for (const key of ['hand', 'command', 'graveyard', 'library', 'exile']) {
    const c = pl.zones[key].find((x) => x.iid === iid);
    if (c) return c;
  }
  return iid ? game.battlefield.find((p) => p.iid === iid) || null : null;
}

export { findCardInZones };
