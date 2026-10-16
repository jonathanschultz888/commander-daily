/**
 * Effect primitives + the effect executor.
 *
 * Every card script — hand-written in scripts.js or auto-compiled from oracle
 * text in compiler.js — compiles down to a list of steps that this module
 * executes against game state. Keeping effects as data (not closures) means a
 * scripted card is inspectable, testable, and reportable in the coverage tool.
 *
 * Targeting (CR 601.2c / 115) is expressed declaratively with `targetSpec`, so
 * the engine can validate legality, ask the human to pick, or let the bot pick.
 */
import {
  isCreature, isLand, isPermanent, isArtifact, isEnchantment, isPlaneswalker,
  characteristics, hasKeyword, makeTokenInstance, isBasicLand, countersPower,
} from './cards.js';

/* ------------------------------------------------------------------ */
/* Target specifications                                               */
/* ------------------------------------------------------------------ */

export const SPECS = {
  anyTarget: { kind: 'permanent-or-player', filter: {} },
  creature: { kind: 'permanent', filter: { creature: true } },
  creatureYouControl: { kind: 'permanent', filter: { creature: true, controller: 'you' } },
  creatureOpponentControls: { kind: 'permanent', filter: { creature: true, controller: 'opp' } },
  creatureOrPlaneswalker: { kind: 'permanent', filter: { creatureOrPlaneswalker: true } },
  artifactOrEnchantment: { kind: 'permanent', filter: { artifactOrEnchantment: true } },
  nonlandPermanent: { kind: 'permanent', filter: { nonland: true } },
  permanent: { kind: 'permanent', filter: {} },
  land: { kind: 'permanent', filter: { land: true } },
  player: { kind: 'player', filter: {} },
  opponent: { kind: 'player', filter: { notController: true } },
  spell: { kind: 'spell', filter: {} },
  creatureYouControlOther: { kind: 'permanent', filter: { creature: true, controller: 'you', other: true } },
};

export function specMatches(g, ctx, spec, entity) {
  const filt = spec.filter || {};
  const isPlayer = typeof entity === 'number';
  if (spec.kind === 'player' && !isPlayer) return false;
  if (spec.kind !== 'player' && isPlayer) return false;
  if (isPlayer) {
    const me = ctx?.controller ?? ctx?.source?.controller;
    if (filt.notController && entity === me) return false;
    if (filt.controller === 'opp' && entity === me) return false;
    return true;
  }
  // A spell on the stack — what a counterspell targets. Stack entries are not
  // permanents and have no zone, so they must be checked before the battlefield
  // test below (which used to reject every one of them, leaving every
  // counterspell in the pool permanently unable to target anything).
  if (spec.kind === 'spell') {
    if (!entity || entity.kind !== 'spell' || !entity.card) return false;
    const types = entity.card.types || [];
    const isCreatureSpell = types.includes('Creature');
    if (filt.creature && !isCreatureSpell) return false;
    if (filt.noncreature && isCreatureSpell) return false;
    const me = ctx?.controller ?? ctx?.source?.controller;
    if (filt.notController !== undefined && entity.controller === me) return false;
    if (filt.controller === 'opp' && entity.controller === me) return false;
    if (filt.manaValueMax !== undefined && (entity.card.cmc || 0) > filt.manaValueMax) return false;
    return true;
  }
  // entity is a permanent
  const p = entity;
  if (!p || p.zone !== 'battlefield') return false;
  if (filt.other && ctx?.source && p.iid === ctx.source.iid) return false;
  const ch = characteristics(g, p);
  if (filt.creature && !ch.isCreature) return false;
  if (filt.nonland && isLand(p)) return false;
  if (filt.land && !isLand(p)) return false;
  if (filt.artifactOrEnchantment && !(isArtifact(p) || isEnchantment(p))) return false;
  if (filt.creatureOrPlaneswalker && !(ch.isCreature || isPlaneswalker(p))) return false;
  if (filt.artifactOrCreature && !(isArtifact(p) || ch.isCreature)) return false;
  if (filt.artifact && !isArtifact(p)) return false;
  if (filt.enchantment && !isEnchantment(p)) return false;
  if (filt.planeswalker && !isPlaneswalker(p)) return false;
  if (filt.legendary && !p.supertypes.includes('Legendary')) return false;
  if (filt.token && !p.isToken) return false;
  if (filt.type && !p.types.includes(filt.type)) return false;
  if (filt.subtype && !p.subtypes.includes(filt.subtype)) return false;
  if (filt.attacking && !p.attacking) return false;
  if (filt.blocking && !p.blocking) return false;
  if (filt.manaValueMax !== undefined && p.cmc > filt.manaValueMax) return false;
  if (filt.powerMax !== undefined && ch.power > filt.powerMax) return false;
  if (filt.powerMin !== undefined && ch.power < filt.powerMin) return false;
  if (filt.toughnessMax !== undefined && ch.toughness > filt.toughnessMax) return false;
  if (filt.controller === 'you' && p.controller !== ctx.controller) return false;
  if (filt.controller === 'opp' && p.controller === ctx.controller) return false;
  if (filt.name && p.name !== filt.name) return false;
  if (filt.anyOf) return filt.anyOf.some((s) => specMatches(g, ctx, { kind: spec.kind, filter: s }, entity));
  if (filt.predicate && !filt.predicate(g, p, ctx)) return false;
  // protection (CR 702.16)
  if (p.protection && p.protection.size) {
    const src = ctx.source;
    if (src) {
      const srcColors = new Set(src.card.colors || []);
      for (const prot of p.protection) {
        if (prot === 'everything') return false;
        if (!['W', 'U', 'B', 'R', 'G'].includes(prot)) continue;
        if (srcColors.has(prot)) return false;
      }
    }
  }
  return true;
}

export function legalTargets(g, ctx, spec) {
  const out = [];
  if (spec.kind === 'permanent' || spec.kind === 'permanent-or-player') {
    out.push(...g.battlefield.filter((p) => specMatches(g, ctx, spec, p)).map((p) => p.iid));
  }
  if (spec.kind === 'player' || spec.kind === 'permanent-or-player') {
    out.push(...g.players.map((pl) => pl.id).filter((id) => specMatches(g, ctx, spec, id)));
  }
  if (spec.kind === 'spell') {
    out.push(...g.stack.filter((s) => s.kind === 'spell' && specMatches(g, ctx, spec, s)).map((s) => s.iid));
  }
  if (spec.kind === 'card' && spec.zone) {
    out.push(...(g.players[ctx.controller].zones[spec.zone] || []).map((c) => c.iid));
  }
  // "up to one" / optional targets
  if (spec.upTo && out.length) out.push(null);
  return out;
}

/* ------------------------------------------------------------------ */
/* Effect steps                                                        */
/* ------------------------------------------------------------------ */

const z = (g, p) => g.players[p].zones;

export function findPermanent(g, iid) {
  return g.battlefield.find((p) => p.iid === iid);
}
export function findCard(g, iid) {
  const perm = findPermanent(g, iid);
  if (perm) return perm;
  for (const p of g.players) {
    for (const key of ['hand', 'library', 'graveyard', 'exile', 'command']) {
      const found = (p.zones[key] || []).find((c) => c.iid === iid);
      if (found) return found;
    }
  }
  return null;
}

export function tokenDef(name, typeLine, power, toughness, extra = {}) {
  return { name, type_line: typeLine, power, toughness, colors: extra.colors || [], keywords: extra.keywords || [], oracle_text: extra.oracle_text || '' };
}

const TREASURE = () => tokenDef('Treasure', 'Token Artifact — Treasure', null, null, {
  oracle_text: '{T}, Sacrifice this token: Add one mana of any color.',
});

/* ------------------------------------------------------------------ */
/* Core primitives — each mutates game state and emits events          */
/* ------------------------------------------------------------------ */

export function draw(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n; i++) {
    if (!pl.zones.library.length) { g.lose(playerId, 'drew from an empty library', { cause: 'library' }); return; }
    const card = pl.zones.library.shift();
    card.zone = 'hand';
    pl.zones.hand.push(card);
    g.emit({ type: 'draw', player: playerId, card: card.iid, amount: 1, ctx });
  }
}

export function mill(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n && pl.zones.library.length; i++) {
    const card = pl.zones.library.shift();
    card.zone = 'graveyard';
    pl.zones.graveyard.push(card);
  }
  if (!pl.zones.library.length) g.lose(playerId, 'library empty', { cause: 'library' });
}

export function gainLife(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  pl.life += n;
  g.emit({ type: 'lifechange', player: playerId, amount: n, gain: true, ctx });
  // "Whenever you gain life" (CR 119.9). The compiler and the hand scripts both
  // listen for `youGainLife`, and nothing used to emit it — so every lifegain
  // payoff in the pool (Sanguine Bond, and anything else printed that way) was
  // silently inert. A 0-life gain is not a gain, so it does not trigger.
  if (n > 0) g.emit({ type: 'youGainLife', player: playerId, amount: n, ctx });
}

export function loseLife(g, playerId, n, ctx = {}) {
  const pl = g.players[playerId];
  pl.life -= n;
  g.emit({ type: 'lifechange', player: playerId, amount: -n, gain: false, ctx });
  // "Whenever you lose life" — same story as `youGainLife` above.
  if (n > 0) g.emit({ type: 'youLoseLife', player: playerId, amount: n, ctx });
}

export function damage(g, targetRef, n, ctx = {}) {
  if (targetRef === null || targetRef === undefined) return;
  const source = ctx.source || null;
  if (n > 0 && source && !ctx.noModifiers) {
    let multiplier = 1, addend = 0;
    for (const mod of (g._staticMods || [])) {
      if (mod.source?.controller !== source.controller) continue;
      if (mod.kind === 'damageMultiplier') multiplier *= mod.amount;
      if (mod.kind === 'damageAddend' && mod.source.iid !== targetRef) addend += mod.amount;
    }
    n = n * multiplier + addend;
  }
  const srcName = source ? source.name : (ctx.sourceName || 'effect');
  if (typeof targetRef === 'number') {
    const pl = g.players[targetRef];
    if (!pl || pl.lost) return;
    // damage to a player from a source with lifelink gains life
    loseLife(g, targetRef, n, ctx);
    g.emit({ type: 'damage', target: targetRef, amount: n, source: source?.iid, isPlayer: true, srcName, ctx });
    if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
    g.checkStateBased();
    return;
  }
  const perm = typeof targetRef === 'object' ? targetRef : findPermanent(g, targetRef);
  if (!perm || perm.zone !== 'battlefield') return;
  if (isPlaneswalker(perm)) {
    const remaining = dealToPlaneswalker(g, perm, n, ctx);
    if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
    return remaining;
  }
  const deathtouch = source && isCreature(source) && hasKeyword(g, source, 'Deathtouch');
  const infect = source && hasKeyword(g, source, 'Infect');
  if (perm.damagePrevention?.length) {
    const prevent = perm.damagePrevention.reduce((a, b) => a + (b.amount < 0 ? n : Math.min(b.amount, n)), 0);
    n = Math.max(0, n - prevent);
    if (!n) return 0;
  }
  perm.damage += n;
  perm.dealtDamageThisTurn = (perm.dealtDamageThisTurn || 0) + n;
  if (deathtouch && isCreature(perm) && n > 0) perm._deathtouchDamage = true;
  g.emit({ type: 'damage', target: perm.iid, amount: n, source: source?.iid, srcName, ctx });
  if (source && isCreature(source) && hasKeyword(g, source, 'Lifelink')) gainLife(g, source.controller, n, ctx);
  if (source && isCreature(source) && hasKeyword(g, source, 'Infect')) {
    // infect: -1/-1 counters instead of damage
    perm.damage -= n;
    addCounters(g, perm, '-1/-1', n, ctx);
  }
  g.checkStateBased();
  // "whenever this deals damage to a creature" style triggers are emitted here
  if (source && !ctx.combat) g.emit({ type: 'sourceDamageToCreature', source: source.iid, target: perm.iid, amount: n, ctx });
  // "Whenever this creature is dealt damage" (Boros Reckoner). The event is the
  // permanent being hurt, not the source dealing it, so the payload carries both.
  if (n > 0) g.emit({ type: 'selfDamaged', card: perm.iid, perm: perm.iid, amount: n, source: source?.iid ?? null, controller: perm.controller, ctx });
  return n;
}

function dealToPlaneswalker(g, pw, n, ctx) {
  pw.counters.loyalty = (pw.counters.loyalty || pw.loyalty || 0) - n;
  g.emit({ type: 'damage', target: pw.iid, amount: n, source: ctx.source?.iid, srcName: ctx.source?.name, ctx });
  g.checkStateBased();
}

/**
 * Put counters on a permanent.
 *
 * `duration` is normally omitted: a counter stays until something removes it
 * (CR 122.1). A handful of effects really do place counters that expire at end of
 * turn, and those are tracked separately so the display can tell the player which
 * counters are permanent and which are about to disappear — and so the cleanup step
 * removes exactly those. A "+1/+1 until end of turn" is NOT a counter; that is a
 * pump effect (`pump()`) and never reaches here.
 */
export function addCounters(g, perm, type, n, ctx = {}, { duration = 'permanent' } = {}) {
  if (!perm) return;
  if (duration === 'eot') {
    perm.tempCounters.push({ type, n, untilEndOfTurn: true, source: ctx.source?.iid || null });
  } else {
    perm.counters[type] = (perm.counters[type] || 0) + n;
    if (type === 'loyalty' && perm.loyalty !== null && perm.counters.loyalty === undefined) perm.counters.loyalty = n;
  }
  g.emit({ type: 'counters', target: perm.iid, counterType: type, amount: n, temporary: duration === 'eot', ctx });
}

/**
 * "Until end of turn, target land becomes a 3/3 Elemental creature" — the animation
 * is a layer-4/7a effect that expires with the turn, not a counter and not a pump.
 */
export function animate(g, perm, spec, ctx = {}, duration = 'eot') {
  if (!perm) return;
  const anim = {
    power: spec.power ?? null, toughness: spec.toughness ?? null,
    types: spec.types || [], subtypes: spec.subtypes || [], keywords: spec.keywords || [],
    source: ctx.source?.iid || null, untilEndOfTurn: duration === 'eot', expired: false,
  };
  perm.animations.push(anim);
  g.emit({ type: 'animated', target: perm.iid, spec: { power: anim.power, toughness: anim.toughness, types: anim.types }, ctx });
  g.recomputeStatics?.();
}

export function destroy(g, perm, ctx = {}) {
  if (!perm) return false;
  if (perm.indestructible || hasKeyword(g, perm, 'Indestructible')) {
    g.emit({ type: 'preventedDestroy', target: perm.iid, ctx });
    return false;
  }
  // regeneration shields
  if (perm.regenShields > 0) {
    perm.regenShields--;
    perm.tapped = true;
    perm.damage = 0;
    g.emit({ type: 'regenerated', target: perm.iid, ctx });
    return false;
  }
  moveToGraveyard(g, perm, ctx);
  return true;
}

export function moveToGraveyard(g, perm, ctx = {}) {
  const owner = g.players[perm.owner];
  const from = perm.zone;
  removeFromBattlefield(g, perm);
  if (perm.isCommander) {
    // CR 903.9: a commander may go to the command zone instead
    perm.zone = 'command';
    owner.zones.command.push(perm);
    g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'command', ctx });
  } else {
    perm.zone = 'graveyard';
    owner.zones.graveyard.push(perm);
    g.emit({ type: 'dies', card: perm.iid, controller: perm.controller, ctx });
    g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'graveyard', ctx });
  }
}

export function exile(g, perm, ctx = {}) {
  if (!perm) return;
  const owner = g.players[perm.owner];
  const from = perm.zone;
  if (perm.zone === 'battlefield') removeFromBattlefield(g, perm);
  perm.zone = 'exile';
  owner.zones.exile.push(perm);
  g.emit({ type: 'zoneChange', card: perm.iid, from, to: 'exile', ctx });
}

export function sacrifice(g, perm, ctx = {}) {
  const controller = perm.controller;
  g.emit({ type: 'sacrifice', card: perm.iid, controller, ctx });
  moveToGraveyard(g, perm, ctx);
  // "whenever you sacrifice a permanent" triggers
  g.emit({ type: 'youSacrificed', player: controller, card: perm.iid, ctx });
}

export function bounce(g, perm, ctx = {}) {
  const owner = g.players[perm.owner];
  removeFromBattlefield(g, perm);
  if (perm.isCommander) {
    // CR 903.9: a commander that would go to its owner's hand may go to the
    // command zone instead. The engine takes that option automatically (as it
    // already does on death) — a commander stranded in hand or in a library
    // would lose its designation, and with it the player's colour identity.
    perm.zone = 'command';
    owner.zones.command.push(perm);
    g.emit({ type: 'zoneChange', card: perm.iid, from: 'battlefield', to: 'command', ctx });
    return;
  }
  perm.zone = 'hand';
  owner.zones.hand.push(perm);
  g.emit({ type: 'zoneChange', card: perm.iid, from: 'battlefield', to: 'hand', ctx });
}

export function removeFromBattlefield(g, perm) {
  const idx = g.battlefield.indexOf(perm);
  if (idx >= 0) g.battlefield.splice(idx, 1);
  // detach anything attached to it, and take it out of its own host's list
  for (const att of perm.attachments) { att.attachedTo = null; }
  perm.attachments = [];
  if (perm.attachedTo) {
    const host = perm.attachedTo;
    host.attachments = (host.attachments || []).filter((a) => a.iid !== perm.iid);
    perm.attachedTo = null;
  }
  perm.attachments = [];
  if (perm.attachedTo) {
    const host = perm.attachedTo;
    host.attachments = host.attachments.filter((a) => a.iid !== perm.iid);
    perm.attachedTo = null;
  }
  perm.tapped = false;
  perm.damage = 0;
  perm.counters = {};
  perm.summoningSick = true;
  perm.tempPumps = [];
  perm.tempCounters = [];
  perm.animations = [];
  perm.staticMods = [];
  perm.keywordGrants = [];
  perm.keywordLoss = [];
  perm.setBase = null; perm.setPT = null; perm.switchPT = false;
  perm.protection = new Set();
  perm.damagePrevention = [];
  perm.enteredThisTurn = false;
  perm.attackedThisTurn = false;
  g.recomputeStatics();
}

export function putPermanent(g, card, playerId, { tapped = false, asToken = false, targets = [], played = false, announced = false } = {}) {
  const inst = asToken
    ? makeTokenInstance(card, { owner: playerId, controller: playerId, iid: g.nextIid() })
    : card;
  inst.controller = playerId;
  inst.owner = inst.owner ?? playerId;
  inst.zone = 'battlefield';
  if (!asToken) {
    const script = g.scriptFor ? g.scriptFor(inst) : null;
    const entersTapped = script?.entersTapped;
    if (typeof entersTapped === 'function' ? entersTapped(g, inst) : entersTapped) tapped = true;
  }
  inst.tapped = tapped;
  inst.enteredThisTurn = true;
  inst.summoningSick = !(inst.keywords.has('Haste'));
  g.battlefield.push(inst);
  // An Aura enters attached to the permanent it was cast on (CR 303.4b). This has
  // to happen before the state-based check below, which would otherwise see an
  // Aura with no host and put it straight into the graveyard.
  if (!asToken && (inst.subtypes || []).includes('Aura')) {
    const host = (targets || [])
      .map((t) => (t && typeof t === 'object' ? t : g.battlefield.find((p) => p.iid === t)))
      .find((t) => t && t !== inst && g.battlefield.includes(t));
    if (host) {
      inst.attachedTo = host;
      if (!host.attachments.includes(inst)) host.attachments.push(inst);
    }
  }
  g.recomputeStatics();
  g.emit({ type: 'etb', card: inst.iid, controller: playerId, isToken: inst.isToken, played, announced });
  if (!asToken && g.runEnterAbility) g.runEnterAbility(inst, playerId, targets);
  g.checkStateBased();
  return inst;
}

export function createTokens(g, playerId, def, n, ctx = {}) {
  // Token-doubling replacement effects (Parallel Lives, Anointed Procession, Doubling Season)
  let count = n;
  for (const mod of (g._staticMods || [])) {
    if (mod.kind === 'tokenDoubler' && mod.source?.controller === playerId) count *= 2;
  }
  // Chatterfang: any token you'd create becomes a Squirrel, plus that many extra Squirrels
  const squirrel = (g._staticMods || []).find((m) => m.kind === 'tokenModifier' && m.modifier === 'squirrel' && m.source?.controller === playerId);
  if (squirrel && !(def.subtypes || []).includes('Squirrel') && (def.type_line || '').includes('Creature')) {
    const extra = count;
    const squirrelDef = tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] });
    const made = [];
    for (let i = 0; i < count; i++) made.push(putPermanent(g, squirrelDef, playerId, { asToken: true }));
    for (let i = 0; i < extra; i++) made.push(putPermanent(g, squirrelDef, playerId, { asToken: true }));
    g.emit({ type: 'tokenReplacement', player: playerId, count: count + extra });
    return made;
  }
  const made = [];
  for (let i = 0; i < count; i++) {
    made.push(putPermanent(g, def, playerId, { asToken: true }));
  }
  return made;
}

export function addMana(g, playerId, color, n, ctx = {}) {
  const pl = g.players[playerId];
  for (let i = 0; i < n; i++) pl.manaPool.push(color === 'any' ? 'C' : color);
  g.emit({ type: 'manaAdded', player: playerId, color, amount: n, ctx });
}

/* ------------------------------------------------------------------ */
/* Choices: the one place where a seat is asked to pick something      */
/* ------------------------------------------------------------------ */

/**
 * Thrown when the human seat has to answer before the game can go on.
 *
 * A resolution cannot block — there is no thread to wait on — so the effect
 * stops exactly where the question is asked, whatever is left of it is queued
 * (see pushDeferred) and the game parks on `game.modal` until the client
 * answers through game.resolveChoice(). Only the human seat does this: a bot
 * answers on the spot, which is why the simulation harness and the tests, where
 * `interactive` is never set, behave exactly as before.
 */
export class DeferResolution {
  constructor(kind) { this.name = 'DeferResolution'; this.kind = kind; this.deferResolution = true; }
}

export const isDefer = (e) => !!(e && e.deferResolution);

/** Queue the rest of a partially resolved effect. Innermost frame first. */
export function pushDeferred(g, frame) {
  if (!frame) return;
  if (!g.deferred) g.deferred = [];
  if (frame.hasClosures) g.deferredHasClosures = true;
  g.deferred.push(frame);
}

/** The answer a bot gives when a script does not care to think about it. */
function defaultPick(g, cards, kind, n) {
  const list = [...cards];
  if (kind === 'sacrifice') list.sort((a, b) => permValue(g, a) - permValue(g, b));
  else list.sort((a, b) => scoreCardForKeep(b, g) - scoreCardForKeep(a, g));
  return list.slice(0, Math.max(1, n));
}

/** The card ids of an answer, however the client or a script phrased it. */
export function answerIds(answer) {
  if (!answer) return [];
  const raw = Array.isArray(answer) ? answer : (answer.picks || answer.iids || answer.cards || []);
  return raw.map((x) => (x && typeof x === 'object' ? x.iid : x)).filter((x) => typeof x === 'string');
}

/**
 * Ask one seat to choose from `cards`, and return whatever `apply` returns: for
 * a bot that is the finished work, for the human it is the answer still to come.
 */
export function askChoice(g, playerId, spec) {
  const { cards = [], kind = 'choose', picks = 1, apply, bot, modal = {}, data = {} } = spec;
  if (!cards.length) return null;
  const humanSeat = playerId === g.humanId && g.interactive === true && !g.humanIsBot;
  if (!humanSeat) {
    const chosen = bot ? bot(cards) : defaultPick(g, cards, kind, picks);
    return apply(chosen);
  }
  g.pendingChoice = { kind, playerId, picks, data, cards: cards.map((c) => c.iid) };
  g.modal = { kind, playerId, picks, ...modal, cards: cards.map((c) => c.iid) };
  throw new DeferResolution(kind);
}

/**
 * Run what was left over when a resolution was suspended, innermost frame first.
 * Returns false if answering asked another question; the remaining work stays
 * queued in that case.
 */
export function resumeDeferred(g) {
  const frames = g.deferred || [];
  g.deferred = [];
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    if (f.hasClosures && !f.resume && !f.ctx) continue;   // revived and not resumable
    try {
      if (f.resume) f.resume(g);
      else runEffects(g, f.ctx, f.steps);
    } catch (e) {
      if (!isDefer(e)) throw e;
      g.deferred = [...(g.deferred || []), ...frames.slice(k + 1)];
      return false;
    }
  }
  return true;
}

/**
 * A pending choice survives a reload as data (kind + spec), not as a closure:
 * this rebuilds the work that applies the answer.
 */
export function rebuildPendingChoice(g, pc) {
  if (!pc) return null;
  const data = pc.data || {};
  switch (pc.kind) {
    case 'search': return (answer) => applySearch(g, data, answerIds(answer));
    case 'topX': return (answer) => applyTopX(g, data, answer);
    case 'discard': return (answer) => discardCards(g, data.playerId, answerIds(answer), {});
    case 'sacrifice': return (answer) => {
      const out = [];
      for (const iid of answerIds(answer)) {
        const p = findPermanent(g, iid);
        if (p) { sacrifice(g, p, {}); out.push(p); }
      }
      return out;
    };
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Effect primitives                                                   */
/* ------------------------------------------------------------------ */

export function untap(g, perm) {
  if (!perm) return;
  perm.tapped = false;
  g.emit({ type: 'untapped', card: perm.iid });
}

export function tapPermanent(g, perm) {
  perm.tapped = true;
  g.emit({ type: 'tapped', card: perm.iid });
}

export function pump(g, perm, power, toughness, ctx = {}, duration = 'eot') {
  if (!perm) return;
  perm.tempPumps.push({ power, toughness, untilEndOfTurn: duration === 'eot', source: ctx.source?.iid || null, expired: false });
  g.emit({ type: 'pumped', target: perm.iid, power, toughness });
}

export function grantKeyword(g, perm, keywords, ctx = {}, duration = 'eot') {
  if (!perm) return;
  perm.keywordGrants.push({ keywords, source: ctx.source?.iid || null, untilEndOfTurn: duration === 'eot', expired: false });
  g.emit({ type: 'keywordGranted', target: perm.iid, keywords });
}

/**
 * Search a library. The *whole* library is filtered by `spec` and every card
 * that passes is what the chooser is allowed to pick from, so the human sees the
 * real contents of their deck rather than a single auto-taken card; the bot
 * keeps a heuristic. Nothing leaves the library before the choice is made.
 */
export function searchLibrary(g, playerId, spec, { destination = 'hand', tapped = false, shuffle = true, count = 1, title = null } = {}, ctx = {}) {
  const pl = g.players[playerId];
  if (!pl) return [];
  const legal = pl.zones.library.filter((c) => spec(c));
  if (!legal.length) { if (shuffle) shuffleLibrary(g, playerId); return []; }
  const n = Math.max(1, Math.min(count || 1, legal.length));
  const data = { op: 'search', playerId, destination, tapped: !!tapped, shuffle: shuffle !== false, count: n };
  return _searchAsk(g, playerId, legal, data, title, pl, n);
}

function _searchAsk(g, playerId, legal, data, title, pl, n) {
  const where = data.destination === 'battlefield' ? 'Onto the battlefield'
    : data.destination === 'hand' ? 'Into your hand' : `To your ${data.destination}`;
  return askChoice(g, playerId, {
    kind: 'search', picks: n, cards: legal, data,
    apply: (answer) => applySearch(g, data, answerIds(answer)),
    bot: (list) => defaultPick(g, list, 'search', n),
    modal: {
      title: title || (n > 1 ? `Search your library for ${n} cards` : 'Search your library for a card'),
      note: `${where}. Every card in your library this effect can find is shown — ${legal.length} of ${pl.zones.library.length}.`,
      zone: 'library', owner: playerId, destination: data.destination, pickCount: n,
      rest: pl.zones.library.filter((c) => !legal.includes(c)).map((c) => c.iid),
    },
  });
}

function applySearch(g, data, iids) {
  const pl = g.players[data.playerId];
  const moved = [];
  for (const iid of iids) {
    const idx = pl.zones.library.findIndex((c) => c.iid === iid);
    if (idx < 0) continue;
    moved.push(pl.zones.library.splice(idx, 1)[0]);
  }
  if (!moved.length) return [];
  // Shuffle first: a search always shuffles, and doing it before anything
  // arrives means an entering permanent's own trigger can never leave the deck
  // half-shuffled.
  if (data.shuffle) shuffleLibrary(g, data.playerId);
  g.emit({ type: 'searched', player: data.playerId, cards: moved.map((c) => c.iid) });
  arriveSearched(g, data, moved, 0);
  return moved;
}

/** Put the found cards where they belong; a suspension keeps the rest queued. */
function arriveSearched(g, data, cards, from) {
  const pl = g.players[data.playerId];
  for (let i = from; i < cards.length; i++) {
    const card = cards[i];
    if (data.destination === 'battlefield') {
      try { putPermanent(g, card, data.playerId, { tapped: data.tapped }); }
      catch (e) {
        if (!isDefer(e)) throw e;
        pushDeferred(g, { ctx: null, steps: [], hasClosures: true, resume: (gg) => arriveSearched(gg, data, cards, i + 1) });
        throw e;
      }
    } else {
      card.zone = data.destination;
      pl.zones[data.destination].push(card);
      g.emit({ type: 'moved', player: data.playerId, card: card.iid, to: data.destination });
    }
  }
}

/**
 * Look at the top `n` cards and put them back in an order the chooser picks:
 * everything in `top` stays on top — left to right is the order they are drawn —
 * and everything in `bottom` goes under the library. That is scry, and it is
 * also what "look at the top three" means when the spell lets you reorder them.
 */
export function lookAtTop(g, playerId, n, ctx = {}, { title = null } = {}) {
  const pl = g.players[playerId];
  const looked = pl.zones.library.slice(0, Math.max(0, n));
  if (!looked.length) return { top: [], bottom: [] };
  const data = { op: 'topX', playerId, n: looked.length };
  return askChoice(g, playerId, {
    kind: 'topX', picks: looked.length, cards: looked, data,
    apply: (answer) => applyTopX(g, data, answer),
    bot: () => ({ top: [...looked].sort((a, b) => scoreCardForKeep(b, g) - scoreCardForKeep(a, g)), bottom: [] }),
    modal: {
      title: title || `Look at the top ${looked.length} card${looked.length === 1 ? '' : 's'} of your library`,
      note: 'Click a card to send it to the other row. What is on top is drawn first.',
      zone: 'library', owner: playerId, rows: true,
      topLabel: 'Stays on top — left to right is the order you draw them',
      bottomLabel: 'Goes to the bottom of the library',
      top: looked.map((c) => c.iid), bottom: [],
    },
  });
}

function applyTopX(g, data, answer = {}) {
  const pl = g.players[data.playerId];
  const looked = pl.zones.library.slice(0, data.n);
  const byIid = new Map(looked.map((c) => [c.iid, c]));
  const pick = (list) => (list || []).map((x) => byIid.get(x && typeof x === 'object' ? x.iid : x)).filter(Boolean);
  const top = pick(answer && (answer.top || (Array.isArray(answer) ? answer : answer.picks)));
  const bottom = pick(answer && answer.bottom);
  const missed = looked.filter((c) => !top.includes(c) && !bottom.includes(c));
  pl.zones.library = [...top, ...missed, ...pl.zones.library.slice(looked.length), ...bottom];
  g.emit({ type: 'lookedAtTop', player: data.playerId, cards: looked.map((c) => c.iid) });
  return { top, bottom };
}

export function shuffleLibrary(g, playerId) {
  g.players[playerId].zones.library = g.rng.shuffle(g.players[playerId].zones.library);
}

export function discard(g, playerId, n, ctx = {}, chooser = null) {
  const pl = g.players[playerId];
  const chosen = [];
  for (let i = 0; i < n && pl.zones.hand.length; i++) {
    let card;
    if (chooser) card = chooser(pl.zones.hand, g, playerId);
    else card = pl.zones.hand[pl.zones.hand.length - 1]; // deterministic: last drawn
    const idx = pl.zones.hand.indexOf(card);
    if (idx < 0) break;
    pl.zones.hand.splice(idx, 1);
    card.zone = 'graveyard';
    pl.zones.graveyard.push(card);
    chosen.push(card);
    g.emit({ type: 'discard', player: playerId, card: card.iid, ctx });
  }
  return chosen;
}

/** Discard exactly these cards (the ones a chooser named). */
export function discardCards(g, playerId, iids, ctx = {}) {
  const pl = g.players[playerId];
  const out = [];
  for (const iid of iids) {
    const idx = pl.zones.hand.findIndex((c) => c.iid === iid);
    if (idx < 0) continue;
    const [card] = pl.zones.hand.splice(idx, 1);
    card.zone = 'graveyard';
    pl.zones.graveyard.push(card);
    out.push(card);
    g.emit({ type: 'discard', player: playerId, card: card.iid, ctx });
  }
  return out;
}

export function returnFromGraveyard(g, playerId, spec, destination = 'battlefield', ctx = {}) {
  const pl = g.players[playerId];
  const idx = pl.zones.graveyard.findIndex(spec);
  if (idx < 0) return null;
  const [card] = pl.zones.graveyard.splice(idx, 1);
  if (destination === 'battlefield') return putPermanent(g, card, playerId, {});
  card.zone = destination;
  pl.zones[destination].push(card);
  return card;
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run a list of effect steps. `ctx` carries source/controller/targets/x.
 * Unknown ops are logged as unsupported rather than crashing the game.
 */
export function runEffects(g, ctx, steps) {
  if (!steps) return;
  const list = Array.isArray(steps) ? steps : [steps];
  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    if (!step) continue;
    try {
      if (typeof step === 'function') { step(g, ctx); continue; }
      runStep(g, ctx, step);
    } catch (e) {
      if (!isDefer(e)) throw e;
      // The question is on screen: keep what has not run yet so it can be run
      // once the answer arrives. Innermost frame first, outer frames record
      // their own tails as the exception unwinds through them.
      const tail = list.slice(i + 1);
      if (tail.length) {
        const hasClosures = tail.some((s) => typeof s === 'function'
          || (s && typeof s === 'object' && Object.values(s).some((v) => typeof v === 'function')));
        pushDeferred(g, { ctx, steps: tail, hasClosures });
      }
      throw e;
    }
  }
}

function targetsOf(g, ctx, step) {
  if (step.target === undefined) return ctx.targets || [];
  if (step.target === 'self') return [ctx.source];
  if (step.target === 'chosen') return ctx.targets || [];
  if (step.target === 'source') return [ctx.source];
  if (step.target === 'controller') return [ctx.controller];
  if (step.target === 'eachOpponent') return g.players.filter((p) => p.id !== ctx.controller).map((p) => p.id);
  if (step.target === 'eachPlayer') return g.players.map((p) => p.id);
  if (typeof step.target === 'string') {
    const spec = SPECS[step.target];
    if (spec) return (ctx.targets || []).length ? ctx.targets : [];
    return [];
  }
  return [];
}

function allMatching(g, filterSpec, ctx) {
  if (!filterSpec) return [];
  if (typeof filterSpec === 'function') return g.battlefield.filter((p) => filterSpec(p, ctx));
  const spec = typeof filterSpec === 'string' ? { kind: 'permanent', filter: SPECS[filterSpec]?.filter || {} } : filterSpec;
  return g.battlefield.filter((p) => specMatches(g, ctx, spec, p));
}

function resolveNumber(v, ctx) {
  return v === 'X' ? (ctx.x || 0) : v;
}

function runStep(g, ctx, step) {
  const me = ctx.controller;
  if (step.n === 'X') step = { ...step, n: ctx.x || 0 };
  switch (step.op) {
    case 'noop': return;
    case 'draw': draw(g, step.who === 'opponent' ? otherPlayer(g, me) : step.who === 'each' ? me : (step.player ?? me), step.n || 1, ctx); return;
    case 'drawEach': for (const pl of g.players) draw(g, pl.id, step.n || 1, ctx); return;
    case 'damage': {
      const targets = targetsOf(g, ctx, step);
      for (const t of (targets.length ? targets : step.targets || [])) damage(g, t, step.n || 0, ctx);
      if (step.eachOpponent) for (const pl of g.players) if (pl.id !== me) damage(g, pl.id, step.n || 0, ctx);
      return;
    }
    case 'damageAll': {
      const perms = allMatching(g, step.filter, ctx).filter((p) => !step.excludeController || p.controller !== me);
      for (const p of perms) damage(g, p, step.n || 0, ctx);
      if (step.players) for (const pl of g.players) if (!step.excludeController || pl.id !== me) damage(g, pl.id, step.n || 0, ctx);
      return;
    }
    case 'destroy': for (const t of targetsOf(g, ctx, step)) destroy(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'destroyAll': for (const p of allMatching(g, step.filter, ctx)) destroy(g, p, ctx); return;
    case 'exile': for (const t of targetsOf(g, ctx, step)) exile(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'exileAll': for (const p of allMatching(g, step.filter, ctx)) exile(g, p, ctx); return;
    case 'sacrifice': {
      const who = step.who === 'each' ? g.players.map((p) => p.id) : [step.player ?? me];
      // Bot seats go first: asking the human suspends the resolution, and
      // anything after that suspension inside this op would be lost.
      const ordered = [...who.filter((p) => !(p === g.humanId && g.interactive === true && !g.humanIsBot)),
        ...who.filter((p) => p === g.humanId && g.interactive === true && !g.humanIsBot)];
      for (const pid of ordered) sacrificeAll(g, pid, step.filter, step.n || 1, ctx, step);
      return;
    }
    case 'sacrificeSelf': sacrifice(g, ctx.source, ctx); return;
    case 'bounce': for (const t of targetsOf(g, ctx, step)) bounce(g, findPermanent(g, t?.iid ?? t), ctx); return;
    case 'bounceAll': for (const p of allMatching(g, step.filter, ctx)) bounce(g, p, ctx); return;
    case 'gainLife': gainLife(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 0, ctx); return;
    case 'loseLife': loseLife(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 0, ctx); return;
    case 'counter': for (const t of targetsOf(g, ctx, step)) addCounters(g, findPermanent(g, t?.iid ?? t), step.counterType || '+1/+1', step.n || 1, ctx, { duration: step.duration || 'permanent' }); return;
    case 'counterAll': for (const p of allMatching(g, step.filter, ctx)) addCounters(g, p, step.counterType || '+1/+1', step.n || 1, ctx, { duration: step.duration || 'permanent' }); return;
    case 'animate': for (const t of targetsOf(g, ctx, step)) animate(g, findPermanent(g, t?.iid ?? t), step, ctx, step.duration || 'eot'); return;
    case 'token': {
      const defs = Array.isArray(step.token) ? step.token : [step.token];
      for (const d of defs) createTokens(g, step.who === 'opponent' ? otherPlayer(g, me) : me, d, step.n || 1, ctx);
      return;
    }
    case 'pump': for (const t of targetsOf(g, ctx, step)) pump(g, findPermanent(g, t?.iid ?? t), step.power || 0, step.toughness || 0, ctx, step.duration || 'eot'); return;
    case 'pumpAll': for (const p of allMatching(g, step.filter, ctx)) pump(g, p, step.power || 0, step.toughness || 0, ctx, step.duration || 'eot'); return;
    case 'grantAll': for (const p of allMatching(g, step.filter, ctx)) grantKeyword(g, p, step.keywords || [], ctx, step.duration || 'eot'); return;
    case 'tokenCopyAll': {
      const tokens = allMatching(g, step.filter || { kind: 'permanent', filter: { token: true, controller: 'you' } }, ctx);
      for (const t of tokens) createTokens(g, me, { name: t.name, type_line: t.card.type_line, power: t.basePower, toughness: t.baseToughness, colors: t.card.colors, keywords: [...t.keywords] }, 1, ctx);
      return;
    }
    case 'grant': for (const t of targetsOf(g, ctx, step)) grantKeyword(g, findPermanent(g, t?.iid ?? t), step.keywords || [], ctx, step.duration || 'eot'); return;
    case 'mill': mill(g, step.who === 'opponent' ? otherPlayer(g, me) : me, step.n || 1, ctx); return;
    case 'millEach': for (const pl of g.players) mill(g, pl.id, step.n || 1, ctx); return;
    case 'discard': discardTarget(g, ctx, step); return;
    case 'discardEach': for (const pl of g.players) discard(g, pl.id, step.n || 1, ctx); return;
    case 'addMana': addMana(g, me, step.color || 'C', step.n || 1, ctx); return;
    case 'untap': for (const t of targetsOf(g, ctx, step)) untap(g, findPermanent(g, t?.iid ?? t)); return;
    case 'untapAll': for (const p of allMatching(g, step.filter, ctx)) untap(g, p); return;
    case 'tap': for (const t of targetsOf(g, ctx, step)) tapPermanent(g, findPermanent(g, t?.iid ?? t)); return;
    case 'search':
      // One question with every legal card in it, rather than N questions in a
      // loop: a suspension mid-loop would lose the rest of the loop.
      searchLibrary(g, me, buildSearchPredicate(step), {
        destination: step.destination || 'hand', tapped: step.tapped ?? false,
        count: step.n || 1, title: step.title || describeSearch(step.filter || {}),
      }, ctx);
      return;
    case 'searchBasics':
      searchLibrary(g, me, (c) => isBasicLand(c) && (step.type ? c.subtypes.includes(step.type) : true), {
        destination: step.destination || 'battlefield', tapped: step.tapped ?? true,
        count: step.n || 1, title: step.title || `Search your library for ${step.n > 1 ? `${step.n} basic lands` : 'a basic land'}`,
      }, ctx);
      return;
    case 'shuffle': shuffleLibrary(g, me); return;
    case 'reanimate': {
      const card = returnFromGraveyard(g, step.who === 'opponent' ? otherPlayer(g, me) : me, (c) => specMatches(g, ctx, { kind: 'permanent', filter: step.filter || { creature: true } }, c), 'battlefield', ctx);
      if (card) g.emit({ type: 'reanimated', card: card.iid, ctx });
      return;
    }
    case 'regenerate': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) p.regenShields = (p.regenShields || 0) + 1; } return;
    case 'preventDamage': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) p.damagePrevention.push({ amount: step.n || 0, source: ctx.source?.iid, expired: false }); } return;
    case 'protection': for (const t of targetsOf(g, ctx, step)) { const p = findPermanent(g, t?.iid ?? t); if (p) step.protection?.forEach((x) => p.protection.add(x)); } return;
    case 'extraTurn': g.extraTurns.push(me); g.emit({ type: 'extraTurn', player: me, ctx }); return;
    case 'loseGame': g.lose(step.who === 'opponent' ? otherPlayer(g, me) : me, step.reason || 'effect', ctx); return;
    case 'winGame': g.win(step.who === 'opponent' ? otherPlayer(g, me) : me, step.reason || 'effect', ctx); return;
    case 'copyPermanent': copyPermanentStep(g, ctx, step); return;
    case 'counterSpell': {
      const spells = g.stack.filter((s) => s.kind === 'spell' && specMatches(g, ctx, { kind: 'spell', filter: step.filter || {} }, s));
      for (const s of spells) g.counterSpell(s, ctx);
      return;
    }
    case 'if': {
      const truthy = typeof step.condition === 'function' ? step.condition(g, ctx) : !!step.condition;
      runEffects(g, ctx, truthy ? step.then : step.otherwise);
      return;
    }
    case 'scryLike':
      // The player gets to look at the real top cards and put them back in the
      // order they want (the bot keeps the best one on top).
      lookAtTop(g, me, step.n || 1, ctx, { title: step.title || null });
      return;
    case 'lookTop': {
      const pl = g.players[me];
      const top = pl.zones.library.shift();
      if (!top) return;
      if (step.destination === 'battlefield') putPermanent(g, top, me, {});
      else if (step.destination === 'hand') { top.zone = 'hand'; pl.zones.hand.push(top); }
      else { top.zone = 'graveyard'; pl.zones.graveyard.push(top); }
      // The card itself is public information: say which one it was.
      g.emit({ type: 'revealed', player: me, card: top.iid, destination: step.destination || 'graveyard', ctx });
      return;
    }
    case 'fireCombo': g.fireCombo(step.name, step.cards || [], ctx); return;
    default:
      g.unsupported.add(step.op);
      return;
  }
}

function otherPlayer(g, me) { return g.players.find((p) => p.id !== me)?.id ?? me; }

function sacrificeAll(g, playerId, filter, n, ctx, step = {}) {
  const spec = typeof filter === 'function' ? filter : (p) => specMatches(g, { ...ctx, controller: playerId }, { kind: 'permanent', filter: filter || {} }, p);
  const candidates = () => g.battlefield.filter((p) => p.controller === playerId && spec(p));
  const humanSeat = playerId === g.humanId && g.interactive === true && !g.humanIsBot;
  if (humanSeat) {
    const list = candidates();
    if (!list.length) return;
    const count = Math.max(1, Math.min(n, list.length));
    const data = { op: 'sacrifice', playerId, n: count };
    askChoice(g, playerId, {
      kind: 'sacrifice', picks: count, cards: list, data,
      apply: (answer) => {
        const out = [];
        for (const iid of answerIds(answer)) {
          const p = g.battlefield.find((x) => x.iid === iid);
          if (p) { sacrifice(g, p, ctx); out.push(p); }
        }
        return out;
      },
      bot: (c) => [...c].sort((a, b) => permValue(g, a) - permValue(g, b)).slice(0, count),
      modal: {
        title: count > 1 ? `Sacrifice ${count} permanents` : 'Sacrifice a permanent',
        note: step.note || 'This effect makes you choose — pick what you can afford to lose.',
        zone: 'battlefield', owner: playerId, pickCount: count,
      },
    });
    return;
  }
  for (let i = 0; i < n; i++) {
    const list = candidates();
    if (!list.length) return;
    // deterministic choice: weakest permanent
    list.sort((a, b) => permValue(g, a) - permValue(g, b));
    sacrifice(g, list[0], ctx);
  }
}

export function permValue(g, p) {
  const ch = characteristics(g, p);
  let v = ch.isCreature ? ch.power + ch.toughness : 3;
  if (p.isCommander) v += 5;
  v += (p.counters['+1/+1'] || 0) * 2;
  v += p.attachments.length * 2;
  return v;
}

function discardTarget(g, ctx, step) {
  const who = step.who === 'opponent' ? otherPlayer(g, ctx.controller) : ctx.controller;
  const n = step.n || 1;
  const hand = g.players[who].zones.hand;
  if (!hand.length) return;
  const worst = (h) => [...h].sort((a, b) => scoreCardForKeep(a, g) - scoreCardForKeep(b, g))[0];
  const humanSeat = who === g.humanId && g.interactive === true && !g.humanIsBot;
  if (humanSeat) {
    const data = { op: 'discard', playerId: who, n };
    askChoice(g, who, {
      kind: 'discard', picks: n, cards: hand, data,
      apply: (answer) => discardCards(g, who, answerIds(answer), ctx),
      bot: (list) => [...list].sort((a, b) => scoreCardForKeep(a, g) - scoreCardForKeep(b, g)).slice(0, n),
      modal: {
        title: n > 1 ? `Discard ${n} cards` : 'Discard a card',
        note: step.note || 'Pick the card you give up — every card in your hand is here.',
        zone: 'hand', owner: who, pickCount: n,
      },
    });
    return;
  }
  discard(g, who, n, ctx, worst);
}

/** "Search your library for a creature (power 2 or less)" — used as a modal title. */
function describeSearch(f = {}) {
  const what = [];
  if (f.basic) what.push('basic land');
  else if (f.land) what.push('land');
  else if (f.creature) what.push(f.subtype ? `${f.subtype} creature` : 'creature');
  else if (f.type) what.push(f.type.toLowerCase());
  else if (f.subtype) what.push(f.subtype);
  if (f.name) what.push(f.name);
  const limits = [];
  if (f.manaValueMax !== undefined) limits.push(`mana value ${f.manaValueMax} or less`);
  if (f.powerMax !== undefined) limits.push(`power ${f.powerMax} or less`);
  if (f.toughnessMax !== undefined) limits.push(`toughness ${f.toughnessMax} or less`);
  return `Search your library for a ${what.join(' ') || 'card'}${limits.length ? ` (${limits.join(', ')})` : ''}`;
}

function buildSearchPredicate(step) {
  const f = step.filter || {};
  return (c) => {
    if (f.basic) return isBasicLand(c);
    if (f.land) return isLand(c);
    if (f.creature) return c.types.includes('Creature');
    if (f.type) return c.types.includes(f.type);
    if (f.subtype) return c.subtypes.includes(f.subtype);
    if (f.name) return c.name.toLowerCase() === f.name.toLowerCase();
    if (f.manaValueMax !== undefined) return c.cmc <= f.manaValueMax;
    if (f.any) return true;
    return false;
  };
}

function copyPermanentStep(g, ctx, step) {
  const target = findPermanent(g, ctx.targets?.[0]?.iid ?? ctx.targets?.[0]);
  if (!target) return;
  const copy = { ...target, iid: g.nextIid(), isToken: true, isCopy: true, counters: { ...target.counters }, attachments: [], attachedTo: null, tempPumps: [], staticMods: [], keywordGrants: [], keywordLoss: [], protection: new Set(target.protection || []) };
  copy.controller = ctx.controller;
  copy.zone = 'battlefield';
  copy.enteredThisTurn = true;
  g.battlefield.push(copy);
  g.recomputeStatics();
  g.emit({ type: 'etb', card: copy.iid, controller: ctx.controller, isToken: true, isCopy: true });
  g.checkStateBased();
  return copy;
}

/** Heuristic used by the deterministic scry/discard helpers. */
export function scoreCardForKeep(card, g) {
  let v = 0;
  if (isLand(card)) v += 4;
  if (card.types.includes('Creature')) v += 3 + (card.cmc <= 4 ? 2 : 0);
  if (card.types.includes('Instant')) v += 3;
  if (card.types.includes('Sorcery')) v += 2;
  if (card.types.includes('Artifact') || card.types.includes('Enchantment')) v += 2;
  v += Math.min(card.cmc, 7);
  if (/destroy|exile|deals? \d+ damage|counter target/i.test(card.oracle_text || '')) v += 3;
  if (/draw (a|two|three|four|x) card/i.test(card.oracle_text || '')) v += 2;
  return v;
}

export { SPECS as TARGET_SPECS };
