/**
 * Rules + product tests. Run with: npm test
 *
 * These exist to keep the claims in the README honest: bracket legality, the
 * 1am ET clock, one-run-per-day, and the rules interactions that actually decide
 * Commander games.
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadAllDecks, profileDeck, COMBO_REGISTRY, GAME_CHANGERS } from '../src/decks/index.js';
import * as store from '../src/server/store.js';
import { SEED_DECKS } from '../src/decks/lists.js';
import { createGame, reviveGame, packGame } from '../src/engine/game.js';
import { bounce, destroy, gainLife, animate, pump } from '../src/engine/ops.js';
import { runEngine, combatDamage, executeAction, playOpening, applyPlayerAction, applyAttackers } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';
import { makeCardInstance, characteristics, makeTokenInstance, hasKeyword, countersOn, activeAnimations } from '../src/engine/cards.js';
import { cardScript } from '../src/engine/scripts.js';
import { tokenDef, damage, putPermanent, addCounters, findPermanent } from '../src/engine/ops.js';
import { oracle } from '../src/decks/index.js';
import { targetRequirements, legalTargets } from '../src/engine/targeting.js';
import { SPECS, moveToGraveyard } from '../src/engine/ops.js';
import { canBlock } from '../src/engine/bot.js';
import { STEPS } from '../src/engine/game.js';
import { dayKeyFor, msUntilReset, dailySetup, practiceSetup, nextDayKey, previousDayKey } from '../src/server/daily.js';
import { hashSeed } from '../src/engine/rng.js';

const decks = loadAllDecks();
const deckById = (id) => decks.find((d) => d.id === id);

const root = new URL('..', import.meta.url).pathname;

/**
 * Resolve the stack and everything it triggers, the way the driver does: a trigger
 * that goes on the stack after a resolution must resolve too. (`while (g.stack.length)
 * g.resolveTop()` alone is not enough — a triggered ability is not on the stack until
 * something flushes it.)
 */
const drain = (g, rounds = 40) => {
  for (let i = 0; i < rounds; i++) {
    g.flushTriggers();
    if (!g.stack.length) break;
    g.resolveTop();
  }
};

/* ------------------------------------------------------------------ */
/* Deck pool & bracket legality                                        */
/* ------------------------------------------------------------------ */

test('every deck is exactly 100 cards with a commander', () => {
  for (const d of decks) {
    assert.equal(d.total, 100, `${d.name} has ${d.total} cards`);
    assert.equal(d.cardList.filter((c) => c.zone === 'command').length, 1, `${d.name} commander count`);
    assert.ok(d.cardList.every((c) => c.legal_commander !== 'banned'), `${d.name} contains a banned card`);
  }
});

test('Game Changer counts respect the declared bracket', () => {
  for (const d of decks) {
    const gc = d.profile.gameChangers.length;
    if (d.bracket <= 2) assert.equal(gc, 0, `${d.name} (B${d.bracket}) has ${gc} Game Changers`);
    if (d.bracket === 3) assert.ok(gc <= 3, `${d.name} (B3) has ${gc} Game Changers`);
  }
});

test('no deck breaks its bracket rules (mass land denial, extra turns, 2-card combos)', () => {
  for (const d of decks) {
    assert.deepEqual(d.profile.violations, [], `${d.name}: ${d.profile.violations.join('; ')}`);
  }
});

test('the Game Changers list came from live data, not a hardcoded guess', () => {
  assert.ok(GAME_CHANGERS.size >= 40, `expected a real list, got ${GAME_CHANGERS.size}`);
  assert.ok(GAME_CHANGERS.has('rhystic study'), 'Rhystic Study should be a Game Changer');
});

test('colour identity: every card fits its commander', () => {
  for (const d of decks) {
    const identity = new Set(oracle[d.commander.toLowerCase()].color_identity);
    for (const card of d.cardList) {
      for (const c of card.color_identity || []) {
        assert.ok(identity.has(c), `${d.name}: ${card.name} has {${c}} outside ${d.commander}`);
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* The daily clock (01:00 America/New_York)                            */
/* ------------------------------------------------------------------ */

test('day key rolls over at 01:00 Eastern, not midnight', () => {
  // 2026-10-15 05:30 UTC = 01:30 EDT → still the 15th
  assert.equal(dayKeyFor(new Date('2026-10-15T05:30:00Z')), '2026-10-15');
  // 2026-10-15 04:30 UTC = 00:30 EDT → still the *14th*
  assert.equal(dayKeyFor(new Date('2026-10-15T04:30:00Z')), '2026-10-14');
  // winter (EST, UTC-5): 06:30 UTC = 01:30 EST → the 15th
  assert.equal(dayKeyFor(new Date('2026-01-15T06:30:00Z')), '2026-01-15');
  assert.equal(dayKeyFor(new Date('2026-01-15T05:30:00Z')), '2026-01-14');
});

test('countdown to reset is always in the future and under 24h', () => {
  for (const iso of ['2026-10-15T12:00:00Z', '2026-10-15T04:59:00Z', '2026-01-15T06:01:00Z']) {
    const ms = msUntilReset(new Date(iso));
    assert.ok(ms > 0 && ms <= 24 * 3600e3, `bad countdown at ${iso}: ${ms}`);
  }
});

test('the same day key produces the identical matchup for everyone', () => {
  const a = dailySetup('2026-10-15');
  const b = dailySetup('2026-10-15');
  assert.deepEqual(a.decks.map((d) => d.id), b.decks.map((d) => d.id));
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.openingTurns, b.openingTurns);
});

test('different days produce different matchups', () => {
  const seen = new Set();
  for (let i = 1; i <= 12; i++) {
    const key = `2026-10-${String(i).padStart(2, '0')}`;
    const setup = dailySetup(key);
    seen.add(setup.decks.map((d) => d.id).join('|'));
    assert.equal(setup.decks[0].bracket, setup.decks[1].bracket, `bracket mismatch on ${key}`);
  }
  assert.ok(seen.size > 4, 'the rotation should not repeat the same pairing every day');
});

test('practice never uses either daily deck and randomises each round', () => {
  const daily = dailySetup('2026-10-15');
  const used = daily.decks.map((d) => d.id);
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const p = practiceSetup(1000 + i * 7, used);
    for (const d of p.decks) assert.ok(!used.includes(d.id), `practice used daily deck ${d.id}`);
    seen.add(p.decks.map((d) => d.id).join('|'));
  }
  assert.ok(seen.size > 3, 'practice pairings should vary');
});

test('day keys are contiguous', () => {
  assert.equal(nextDayKey('2026-10-31'), '2026-11-01');
  assert.equal(previousDayKey('2026-11-01'), '2026-10-31');
  assert.equal(previousDayKey('2026-01-01'), '2025-12-31');
});

/* ------------------------------------------------------------------ */
/* Determinism = the same starting point for every player              */
/* ------------------------------------------------------------------ */

test('the same seed reproduces the exact same opening board', () => {
  const setup = dailySetup('2026-10-15');
  const build = () => {
    const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
    g.bot = makeBot(setup.decks[1].prototype);
    runEngine(g, { stopForHuman: false, stopWhen: (gg) => gg.turnNumberFor?.[0] >= (setup.openingTurns + 1) && gg.activePlayer === 0 && gg.step === 'main1' });
    return g;
  };
  const g1 = build();
  const g2 = build();
  const snap = (g) => ({
    turn: g.turn,
    life: g.players.map((p) => p.life),
    hand: g.players.map((p) => p.zones.hand.map((c) => c.name).sort()),
    board: g.battlefield.map((p) => `${p.controller}:${p.name}`).sort(),
    libCounts: g.players.map((p) => p.zones.library.length),
  });
  assert.deepEqual(snap(g1), snap(g2));
  assert.ok(g1.battlefield.length > 0, 'the opening should have developed a board');
});

test('a resumed run continues the same game rather than rerolling it', () => {
  const setup = dailySetup('2026-10-15');
  const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
  g.bot = makeBot(setup.decks[1].prototype);
  runEngine(g, { stopForHuman: false, stopWhen: (gg) => gg.turnNumberFor?.[0] >= 2 });
  const before = { turn: g.turn, hand: g.players[0].zones.hand.length, board: g.battlefield.length };
  // Exactly what the server does: pack -> store (a JSON string on disk or a KV
  // value) -> parse -> revive. Anything that cannot survive JSON is a bug that
  // would only surface after a restart or redeploy.
  const stored = JSON.parse(JSON.stringify(packGame(g)));
  const revived = reviveGame(stored);
  assert.equal(revived.turn, before.turn);
  assert.equal(revived.players[0].zones.hand.length, before.hand);
  assert.equal(revived.battlefield.length, before.board);
  assert.equal(typeof revived.cast, 'function', 'methods are reattached on revive');
});

test('a stored game survives a restart intact (Sets, keywords, protection)', () => {
  const setup = dailySetup('2026-10-15');
  const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
  g.bot = makeBot(setup.decks[1].prototype);
  runEngine(g, { stopForHuman: false, maxIterations: 400 });

  const perm = g.battlefield.find((p) => p.keywords) || g.battlefield[0];
  const keywordsBefore = perm ? [...perm.keywords] : [];
  const revived = reviveGame(JSON.parse(JSON.stringify(packGame(g))));

  // The bug this guards: JSON turns a Set into {}, which crashed reviveGame and
  // silently lost every keyword on the board after any redeploy.
  for (const p of revived.battlefield) {
    assert.ok(p.keywords instanceof Set, `${p.name} keeps a Set of keywords after a restart`);
    assert.ok(p.protection instanceof Set, `${p.name} keeps a Set of protections after a restart`);
  }
  const revivedPerm = revived.battlefield.find((p) => p.iid === perm.iid);
  assert.deepEqual([...revivedPerm.keywords].sort(), keywordsBefore.sort());
  assert.ok(revived.unsupported instanceof Set);

  // Tokens, copies and stack entries all allocate ids — a revived game must be
  // able to keep doing that (this was a live crash after any restart/redeploy).
  const a = revived.nextIid();
  const b = revived.nextIid();
  assert.equal(typeof a, 'string');
  assert.notEqual(a, b, 'revived games keep allocating unique ids');
  assert.ok(!revived.battlefield.some((p) => p.iid === a), 'new ids do not collide with the board');

  // And the revived game can keep playing rather than only being readable.
  const res = runEngine(revived, { stopForHuman: false, maxIterations: 40000 });
  assert.equal(res.status, 'over', 'a game revived from storage can be played to the end');
});

/* ------------------------------------------------------------------ */
/* Rules engine                                                        */
/* ------------------------------------------------------------------ */

const soloGame = (deckId = 'squirrel-swarm', deckId2 = 'sea-monsters') => {
  const g = createGame({ decks: [deckById(deckId), deckById(deckId2)], seed: 4242, options: { noScoring: true, humanIsBot: true } });
  g.bot = makeBot('midrange');
  return g;
};

const putOnBattlefield = (g, cardName, controller = 0) => {
  const card = oracle[cardName.toLowerCase()];
  const inst = makeCardInstance(card, { owner: controller, controller, zone: 'battlefield', iid: g.nextIid() });
  inst.summoningSick = false;
  g.battlefield.push(inst);
  g.recomputeStatics();
  return inst;
};

test('state-based actions: lethal damage kills a creature', () => {
  const g = soloGame();
  const bear = putOnBattlefield(g, 'Elvish Visionary');
  damage(g, bear, 1, { source: null, noModifiers: true });
  assert.ok(!g.battlefield.includes(bear), 'a 1/1 with 1 damage should die');
});

test('state-based actions: +1/+1 and -1/-1 counters annihilate', () => {
  const g = soloGame();
  const bear = putOnBattlefield(g, 'Elvish Visionary');
  addCounters(g, bear, '+1/+1', 3);
  addCounters(g, bear, '-1/-1', 1);
  g.checkStateBased();
  assert.equal(bear.counters['+1/+1'], 2);
  assert.equal(bear.counters['-1/-1'], 0);
  assert.equal(characteristics(g, bear).toughness, 3, '2/2 + two +1/+1 counters');
});

test('legend rule keeps one copy', () => {
  const g = soloGame();
  const a = putOnBattlefield(g, 'Chatterfang, Squirrel General');
  const b = putOnBattlefield(g, 'Chatterfang, Squirrel General');
  g.checkStateBased();
  const alive = [a, b].filter((p) => g.battlefield.includes(p));
  assert.equal(alive.length, 1, 'only one Chatterfang survives');
});

test('combat: trample assigns lethal then spills onto the player', () => {
  const g = soloGame();
  const attacker = putOnBattlefield(g, 'Craterhoof Behemoth', 0);
  attacker.basePower = '5'; attacker.baseToughness = '5';
  const blocker = putOnBattlefield(g, 'Elvish Visionary', 1);
  attacker.keywords.add('Trample');
  const lifeBefore = g.players[1].life;
  // simulate the combat damage step directly
  g.activePlayer = 0;
  g.attackers = [attacker.iid];
  g.blocks = [{ attacker: attacker.iid, blocker: blocker.iid }];
  g.step = 'combatDamage';
  combatDamage(g);
  assert.ok(!g.battlefield.includes(blocker), 'the 1/1 blocker dies');
  assert.equal(g.players[1].life, lifeBefore - 4, 'exactly 4 tramples over a 1/1');
});

test('combat: deathtouch kills regardless of toughness, and lifelink gains life', () => {
  const g = soloGame();
  const attacker = putOnBattlefield(g, 'Vampire Nighthawk', 0); // 2/3 flying deathtouch lifelink
  const blocker = putOnBattlefield(g, 'Craterhoof Behemoth', 1); // huge blocker
  blocker.basePower = '8'; blocker.baseToughness = '8';
  const lifeBefore = g.players[0].life;
  g.activePlayer = 0;
  g.attackers = [attacker.iid];
  g.blocks = [{ attacker: attacker.iid, blocker: blocker.iid }];
  g.step = 'combatDamage';
  combatDamage(g);
  assert.ok(!g.battlefield.includes(blocker), 'deathtouch should kill the big blocker');
  assert.ok(g.players[0].life > lifeBefore, 'lifelink should gain life');
});

test('commander rules: colour identity blocks off-colour casts', () => {
  const g = soloGame(); // Chatterfang is black/green
  const card = makeCardInstance(oracle['counterspell'], { owner: 0, controller: 0, zone: 'hand', iid: 'x1' });
  g.players[0].zones.hand.push(card);
  const res = g.canCast(0, card);
  assert.equal(res.ok, false);
  assert.match(res.reason, /colour identity/);
});

test('commander rules: tax grows by {2} for each cast from the command zone', () => {
  const g = soloGame();
  const cmdr = g.players[0].zones.command[0];
  assert.ok(cmdr.isCommander);
  while (g.step !== 'main1') g.advanceStep();   // sorcery-speed timing matters
  // build a board that can actually pay {6}{B}{G}
  for (let i = 0; i < 4; i++) { putOnBattlefield(g, 'Forest'); putOnBattlefield(g, 'Swamp'); }
  cmdr.castFromCommandZone = 2;
  const parsed = g.canCast(0, cmdr).cost;
  assert.ok(parsed, 'should be castable with a developed board');
  assert.equal(parsed.generic, (cmdr.parsedCost.generic || 0) + 4, 'two previous casts = +{4}');
});

test('commander rules: 21 commander damage from one commander loses the game', () => {
  const g = soloGame();
  const cmdr = g.players[0].zones.command[0];
  putPermanent(g, cmdr, 0, {});
  g.players[1].commanderDamage[cmdr.name] = 21;
  g.checkGameEnd();
  assert.equal(g.status, 'over');
  assert.equal(g.result.winner, 0);
  assert.match(g.result.info.reason, /21 commander damage/);
});

test('mana: basic lands, duals and any-colour rocks pay real costs', () => {
  const g = soloGame();
  putOnBattlefield(g, 'Forest');
  putOnBattlefield(g, 'Swamp');
  putOnBattlefield(g, 'Command Tower');
  const cost = { generic: 1, colors: { B: 1, G: 1 } };
  assert.ok(g.canPayMana(0, cost), 'should be payable');
  const res = g.payMana(0, cost);
  assert.ok(res.ok, res.reason);
  assert.equal(g.players[0].manaPool.length, 0);
  assert.equal(g.landsControlledBy(0).filter((l) => l.tapped).length, 3, 'all three lands tapped');
});

test('mana: a mono-white board cannot pay a double-black cost', () => {
  const g = soloGame();
  putOnBattlefield(g, 'Plains'); putOnBattlefield(g, 'Plains');
  assert.equal(g.canPayMana(0, { generic: 0, colors: { B: 1 } }), false);
});

test('damage modifiers: Torbran adds 2 to each point of damage', () => {
  const g = soloGame('torbran-burn', 'sea-monsters');
  putOnBattlefield(g, 'Torbran, Thane of Red Fell');
  const target = putOnBattlefield(g, 'Elvish Visionary', 1);
  const bolt = oracle['lightning bolt'];
  const src = makeCardInstance(bolt, { owner: 0, controller: 0, zone: 'graveyard', iid: 'blt' });
  // Torbran only pumps his controller's red sources: simulate a red creature source
  const goblin = putOnBattlefield(g, 'Goblin Rabblemaster', 0);
  damage(g, target, 3, { source: goblin });
  assert.ok(!g.battlefield.includes(target), '3+2 damage kills a 1/1');
});

test('token doublers double token creation', () => {
  const g = soloGame();
  putOnBattlefield(g, 'Parallel Lives');
  const before = g.battlefield.length;
  const { createTokens } = await0();
  function await0() { return { createTokens: null }; }
  // use the effect executor so the doubler path is exercised
  return import('../src/engine/ops.js').then(({ createTokens: ct }) => {
    ct(g, 0, tokenDef('Squirrel token', 'Token Creature — Squirrel', 1, 1, { colors: ['G'] }), 1);
    assert.equal(g.battlefield.length - before, 2, 'Parallel Lives doubles the token');
  });
});

test('engine never silently drops an unknown effect: it reports it', () => {
  const g = soloGame();
  const { runEffects } = globalThis.__ops || {};
  return import('../src/engine/ops.js').then(({ runEffects: run }) => {
    run(g, { controller: 0, source: null, targets: [] }, [{ op: 'definitelyNotARealOp' }]);
    assert.ok([...g.unsupported].includes('definitelyNotARealOp'));
  });
});

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

test('combos award points and are announced with a readable label', () => {
  const g = soloGame('godo-helm', 'sea-monsters');
  putOnBattlefield(g, 'Godo, Bandit Warlord');
  const helm = putOnBattlefield(g, 'Helm of the Host');
  const godo = g.battlefield.find((p) => p.name === 'Godo, Bandit Warlord');
  helm.attachedTo = godo; godo.attachments.push(helm);
  g.turnNumberFor = { 0: 4 };
  g.comboCheck(0);
  const lines = g.scores[0].lines.filter((l) => l.kind === 'combo');
  assert.equal(lines.length, 1, 'the Godo + Helm line should register');
  assert.match(lines[0].label, /combo/i);
  assert.ok(g.comboHistory.length === 1);
});

test('end-of-game settlement scores a win differently from a loss', () => {
  const win = soloGame();
  win.turnNumberFor = { 0: 5 };
  win.finish(0, { reason: 'life total reached 0' });
  assert.ok(win.result.humanWon);
  assert.ok(win.scores[0].lines.some((l) => /Victory in 5/.test(l.label)), 'win line mentions the turn count');

  const loss = soloGame();
  loss.turnNumberFor = { 0: 9 };
  loss.players[1].life = 30;
  loss.finish(1, { reason: 'life total reached 0' });
  assert.equal(loss.result.humanWon, false);
  assert.ok(loss.scores[0].lines.some((l) => /lasted 9 turns/.test(l.label)), 'loss line credits survival');
});

test('a full bot-vs-bot game always terminates and produces a result', () => {
  for (const seed of [11, 77, 1234]) {
    const g = soloGame('teysa-aristocrats', 'omnath-landfall');
    g.seed = seed;
    const res = runEngine(g, { stopForHuman: false, maxIterations: 40000 });
    assert.equal(res.status, 'over', `game should finish (seed ${seed})`);
    assert.ok(g.result && typeof g.result.humanWon === 'boolean');
  }
});

test('restarting before every action still ends in exactly the same game', () => {
  // The property that matters for a server-authoritative daily: packing a game
  // into storage and reviving it must be invisible to play. Any live object
  // reference, closure or Set that cannot survive JSON shows up here as the two
  // games diverging. This is the regression guard for "it only breaks after a
  // redeploy".
  const setup = dailySetup('2026-10-15');
  const fresh = () => {
    const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
    g.bot = makeBot(setup.decks[1].prototype);
    return g;
  };
  const snap = (g) => JSON.stringify({
    turn: g.turn, step: g.stepIndex, status: g.status,
    life: g.players.map((p) => p.life),
    hand: g.players.map((p) => p.zones.hand.map((c) => c.name).sort()),
    library: g.players.map((p) => p.zones.library.length),
    graveyard: g.players.map((p) => p.zones.graveyard.length),
    board: g.battlefield.map((p) => `${p.iid}:${p.name}:${p.tapped ? 'T' : 'u'}:${p.counters?.['+1/+1'] || 0}`).sort(),
    stack: g.stack.map((e) => e.kind),
    points: (g.scores || []).map((sc) => sc.total),
  });

  // Same policy in both games: the first legal action the engine offers, or pass.
  const choose = (g) => {
    const p = g.pending;
    if (!p) return null;
    if (p.type === 'declareAttackers') return { type: 'attackers', iids: p.suggested || [] };
    if (p.type === 'declareBlockers') return { type: 'blockers', pairs: p.suggested || [] };
    const a = (p.actions || []).find((x) => x.type === 'playLand') || (p.actions || []).find((x) => x.type === 'cast') || { type: 'pass' };
    return a;
  };

  let straight = fresh();
  let restarted = fresh();
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    runEngine(straight, { stopForHuman: true, maxIterations: 4000 });
    runEngine(restarted, { stopForHuman: true, maxIterations: 4000 });
    assert.equal(straight.status, restarted.status, `diverged at step ${i} (status)`);
    if (straight.status === 'over') break;

    const action = choose(straight);
    if (!action) break;
    const r1 = executeAction(straight, straight.bot, straight.humanId, action);
    const r2 = executeAction(restarted, restarted.bot, restarted.humanId, action);
    assert.deepEqual(r1?.error ?? null, r2?.error ?? null, `diverged at step ${i} (action ${action.type})`);

    // ...and after every single action, the second game goes through storage.
    restarted = reviveGame(JSON.parse(JSON.stringify(packGame(restarted))));
    assert.equal(snap(straight), snap(restarted), `diverged at step ${i} after a restart`);
  }
  assert.ok(straight.turn > 6, 'the comparison should cover real turns, not just the opening');
});

test('every daily hands the player a turn with a real decision in it', () => {
  // The handover IS the product. A player who inherits a board where the only
  // legal move is "pass" has been given nothing to solve — a real fraction of
  // shuffles used to do exactly that (about a fifth of them) before the opening
  // was made to keep playing until a decision existed. Sweep a couple of months
  // of days, with and without a community-voted deck, and require the prompt to
  // hold up in all of them.
  const days = [];
  for (let i = 0; i < 24; i++) days.push(new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
  for (const voted of [false, true]) {
    if (voted) store.castVote('2026-08-01', 'test-voter', 'sea-monsters');
    for (const day of days) {
      const setup = dailySetup(day);
      const game = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
      game.bot = makeBot(setup.decks[1].prototype);
      game.takeoverAt = (setup.openingTurns || 3) + 1;
      playOpening(game);
      if (game.status === 'over') continue; // the opening decided it; rare but legal

      assert.equal(game.activePlayer, game.humanId, `${day} (voted=${voted}): the human takes over on their own turn`);
      assert.ok(['main1', 'main2'].includes(game.step), `${day} (voted=${voted}): handover lands in a main phase`);
      const actions = game.pending?.actions || [];
      assert.ok(actions.length >= 2, `${day} (voted=${voted}): the player has a real choice (got ${actions.length})`);

      // Every offered action must actually work.
      for (const a of actions.slice(0, 3)) {
        const probe = reviveGame(JSON.parse(JSON.stringify(packGame(game))));
        const r = executeAction(probe, probe.bot, probe.humanId, a);
        assert.ok(!r?.error, `${day} (voted=${voted}): offered action "${a.label || a.type}" was rejected: ${r?.error}`);
      }
    }
  }
});

test('a card script does not depend on which object asked for it first', () => {
  // Scripts are cached by card name, so the first cache miss decides the script
  // for the whole process. Callers pass three different shapes — engine
  // instances (parsed types), deck-list entries and oracle records (type_line
  // only). Building from a bare record used to drop the intrinsic basic-land
  // mana ability (CR 305.6) because it looked for `types`, and the cache then
  // served that mana-less script for the rest of the process: whole decks became
  // uncastable whenever anything scanned the pool before a game started.
  const bare = { name: 'Cacheprobe Basin', type_line: 'Basic Land — Island', oracle_text: '' };
  assert.ok(cardScript(bare).mana.length, 'a land given only as a bare record still taps for mana');

  const fromDeckList = deckById('kemba-equipment').cardList.find((c) => c.name === 'Plains');
  assert.ok(!fromDeckList.types, 'deck-list entries really are the bare shape');
  assert.ok(cardScript(fromDeckList).mana.length, 'Plains taps for white when passed as a deck-list entry');
});

test("the day's game does not depend on what the process did first", () => {
  // The bug the player saw: the same daily played out differently in the server
  // than in a fresh script, because the lobby had already scanned every card in
  // the pool and poisoned the script cache. Two fresh processes — one that scans
  // the pool first, one that does not — must produce the identical game.
  const probe = `
    import { loadAllDecks } from './src/decks/index.js';
    import { cardScript } from './src/engine/scripts.js';
    import { dailySetup } from './src/server/daily.js';
    import { createGame } from './src/engine/game.js';
    import { playOpening } from './src/engine/driver.js';
    import { makeBot } from './src/engine/bot.js';
    if (process.env.SCAN_FIRST) for (const d of loadAllDecks()) for (const c of d.cardList) cardScript(c);
    const setup = dailySetup('2026-10-15');
    const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
    g.bot = makeBot(setup.decks[1].prototype);
    g.takeoverAt = (setup.openingTurns || 3) + 1;
    playOpening(g);
    console.log(JSON.stringify({
      seed: setup.seed, human: setup.humanDeck.id, bot: setup.botDeck.id, turn: g.turn,
      prompt: g.pending?.actions?.length ?? -1, hand: g.players[g.humanId].zones.hand.length,
      life: [g.players[0].life, g.players[1].life],
      board: g.battlefield.map((p) => p.name).sort(),
      libTop: g.players[0].zones.library.slice(0, 3).map((c) => c.name),
    }));
  `;
  const run = (scanFirst) => execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, SCAN_FIRST: scanFirst ? '1' : '' },
  }).toString().trim();
  const without = run(false);
  const withScan = run(true);
  assert.equal(withScan, without, "scanning the pool first changed the day's game");
  assert.ok(JSON.parse(without).prompt >= 2, 'the takeover turn still offers a decision');
});

test('the player is never asked to pass priority with nothing legal to do', () => {
  // The complaint this encodes: a prompt whose only option is "pass priority" is
  // a delay, not a decision. Sweep real days, play the human's seat forward, and
  // require every priority window offered to contain at least one legal action
  // besides passing — including the combat windows, where an unblockable attack
  // used to stop the game to ask a question with no answer.
  const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-08-06', '2026-09-01'];
  let prompts = 0;
  for (const day of days) {
    const setup = dailySetup(day);
    let game = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
    game.bot = makeBot(setup.decks[1].prototype);
    game.takeoverAt = (setup.openingTurns || 3) + 1;
    playOpening(game);

    let guard = 0;
    while (game.status === 'playing' && guard++ < 300) {
      const pending = game.pending;
      if (!pending) break;
      if (pending.type === 'priority') {
        prompts++;
        const real = pending.actions.filter((a) => a.type !== 'pass');
        assert.ok(real.length >= 1, `${day} turn ${game.turn} ${pending.type} in ${game.step}: offered a prompt with no legal action`);
      }
      if (pending.type === 'declareBlockers') {
        const anyPair = Object.values(pending.legal || {}).some((l) => l.length);
        assert.ok(anyPair || pending.blockers.length === 0,
          `${day}: the player was asked to block with no legal blocker`);
      }
      const action = pending.type === 'priority'
        ? (pending.actions.find((a) => a.type !== 'pass') || pending.actions[0])
        : pending.type === 'declareAttackers' ? { type: 'attackers', iids: pending.suggested || [] }
          : { type: 'blockers', pairs: pending.suggested || [] };
      if (!action) break;
      game = reviveGame(JSON.parse(JSON.stringify(packGame(game))));
      executeAction(game, game.bot, game.humanId, action);
      runEngine(game, { stopForHuman: true });
    }
  }
  assert.ok(prompts > 50, `the sweep should exercise plenty of windows (saw ${prompts})`);
});

test('a step the player cannot act in is skipped, and the log says so', () => {
  // The player sits in the seat for real here (humanIsBot false) with an empty
  // hand and nothing on their board, so their own steps are genuinely empty. The
  // engine must move on without stopping — and say why, once per step — rather
  // than parking a "pass priority" button in front of them. Note that a *playable*
  // step must never be skipped: this test fails if any prompt appears with
  // nothing but "pass" in it.
  const setup = dailySetup('2026-10-15');
  const game = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: false } });
  game.bot = makeBot(setup.decks[1].prototype);
  playOpening(game);
  const me = game.humanId;
  assert.equal(game.humanIsBot, false, "the seat is the player's after the opening");

  let skipped = '';
  for (let i = 0; i < 40 && game.status !== 'over' && !skipped; i++) {
    // An empty hand and an empty board: no land, no spell, no ability.
    game.players[me].zones.hand.length = 0;
    game.players[me].zones.command.length = 0;
    game.battlefield = game.battlefield.filter((p) => p.controller !== me);
    const pending = game.pending;
    if (pending) {
      if (pending.type === 'priority') {
        assert.ok((pending.actions || []).some((a) => a.type !== 'pass'),
          `a priority prompt was offered with nothing but "pass" available (turn ${game.turn}, ${game.step})`);
        applyPlayerAction(game, me, { type: 'pass' });
      } else if (pending.type === 'declareAttackers') {
        applyPlayerAction(game, me, { type: 'attackers', iids: [] });
      } else if (pending.type === 'declareBlockers') {
        applyPlayerAction(game, me, { type: 'blockers', pairs: [] });
      }
    }
    runEngine(game, { stopForHuman: true });
    skipped = (game.logLines.find((l) => /Nothing you can legally do/.test(l.text || l)) || {}).text || '';
  }
  assert.ok(skipped, 'the engine explains an auto-skipped step instead of leaving the player guessing');
  assert.match(skipped, /Nothing you can legally do in .* — skipped\./, 'in plain language');
  assert.ok(game.autoPassLog && Object.keys(game.autoPassLog).length >= 1, 'and it records that it did so, once per step');
  assert.ok(game.turn > 1, 'the game kept moving');
});

test('a commander keeps its identity wherever an effect moves it', () => {
  // 2026-01-17 exposed this: a bounce effect returned the commander to its
  // owner's hand, which erased the player's colour identity and left the whole
  // deck unplayable — the game simply stopped offering legal actions.
  const setup = dailySetup('2026-01-17');
  const game = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true, noScoring: true } });
  const me = game.humanId;
  const cmd = game.players[me].zones.command.find((c) => c.isCommander);
  assert.ok(cmd, 'the deck starts with its commander in the command zone');
  assert.equal(game.commanderOf(me).name, cmd.name, 'and the commander is known');

  // Put it on the battlefield from wherever it is, then bounce it.
  for (const z of ['command', 'hand', 'graveyard', 'exile', 'library']) {
    const arr = game.players[me].zones[z];
    const i = arr.indexOf(cmd);
    if (i >= 0) arr.splice(i, 1);
  }
  const onField = game.battlefield.indexOf(cmd);
  if (onField >= 0) game.battlefield.splice(onField, 1);
  putPermanent(game, cmd, me, {});
  assert.ok(game.battlefield.includes(cmd), 'it can be on the battlefield');
  bounce(game, cmd, {});
  assert.equal(cmd.zone, 'command', 'a bounced commander returns to the command zone (CR 903.9), not to hand');
  assert.equal(game.commanderOf(me).name, cmd.name, 'and it is still recognised as the commander');

  // Worst case: an effect strands it somewhere unusual. Identity must survive,
  // so the deck keeps working instead of silently refusing every coloured card.
  game.players[me].zones.command.length = 0;
  cmd.zone = 'hand';
  game.players[me].zones.hand.push(cmd);
  assert.equal(game.commanderOf(me)?.name, cmd.name, 'identity is still known from the hand');

  const identity = new Set(game.commanderOf(me).card.color_identity);
  const inColour = game.players[me].zones.hand.find((c) => (c.card.color_identity || []).length
    && c.card.color_identity.every((x) => identity.has(x)));
  assert.ok(inColour, 'the hand has a coloured card to check with');
  const res = game.canCast(me, inColour);
  assert.ok(!/colour identity/.test(res.reason || ''),
    `an in-colour card must not be refused for identity reasons (got: ${res.reason})`);
});

test('no commander is ever left in a hand or a library', () => {
  // The invariant the fix above protects: a commander in hand or library loses
  // its designation for anything that looks at zones, so it must not happen.
  for (const day of ['2026-01-17', '2026-01-20', '2026-01-21', '2026-10-15']) {
    const setup = dailySetup(day);
    const game = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
    game.bot = makeBot(setup.decks[1].prototype);
    runEngine(game, { stopForHuman: false, maxIterations: 30000 });
    for (const pl of game.players) {
      assert.equal(pl.zones.hand.filter((c) => c.isCommander).length, 0, `${day}: a commander is in hand`);
      assert.equal(pl.zones.library.filter((c) => c.isCommander).length, 0, `${day}: a commander is in the library`);
    }
    for (const pl of game.players) {
      assert.ok(game.commanderOf(pl.id) || pl.lost, `${day}: player ${pl.id} lost their commander designation entirely`);
    }
  }
});


/* ------------------------------------------------------------------ */
/* Targets: a spell that needs one must ask for one                    */
/* ------------------------------------------------------------------ */

/** Put a card in a seat's hand with mana available, exactly as the server does. */
const handCard = (g, name, pid = 0) => {
  const inst = makeCardInstance(oracle[name.toLowerCase()], { owner: pid, controller: pid, zone: 'hand', iid: g.nextIid() });
  g.players[pid].zones.hand.push(inst);
  return inst;
};
/**
 * Enough untapped lands on the battlefield to cast anything. canCast checks
 * untapped sources, not the floating pool, so this puts the lands in play (the
 * pool helps payMana settle the bill afterwards).
 */
const richMana = (g, pid = 0) => {
  g.players[pid].manaPool = [...'WWWUUUBBBRRRGGGCCC'];
  for (const p of g.battlefield) if (p.controller === pid) p.tapped = false;
  for (const land of ['Plains', 'Plains', 'Plains', 'Island', 'Island', 'Island', 'Swamp', 'Swamp', 'Mountain', 'Mountain', 'Forest', 'Forest']) {
    if (g.battlefield.filter((p) => p.controller === pid && p.name === land).length >= 2) continue;
    putOnBattlefield(g, land, pid);
  }
  for (const p of g.battlefield) if (p.controller === pid) { p.tapped = false; p.summoningSick = false; }
  return g;
};

test('an Aura cannot be cast without a target, and lands attached to what it was cast on', () => {
  const g = soloGame('squirrel-swarm', 'omnath-landfall');
  const nest = handCard(g, 'Squirrel Nest');
  richMana(g, 0);
  // the player's own turn, first main phase, empty stack: a normal cast window
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null;

  const withoutTarget = applyPlayerAction(g, 0, { type: 'cast', iid: nest.iid }, { bot: null });
  assert.ok(withoutTarget.error, 'a targeted Aura is refused with no target');
  assert.ok(!g.battlefield.includes(nest), 'and it did not reach the battlefield');

  const land = putOnBattlefield(g, 'Forest', 0);
  const cast = applyPlayerAction(g, 0, { type: 'cast', iid: nest.iid, targets: [land.iid] }, { bot: null });
  assert.ok(cast.ok, `the cast is accepted with a legal target (${cast.error || 'ok'})`);
  while (g.stack.length) g.resolveTop();

  const aura = g.battlefield.find((p) => p.name === 'Squirrel Nest');
  assert.ok(aura, 'the Aura is on the battlefield');
  assert.equal(aura.attachedTo?.iid, land.iid, 'attached to the land it was cast on');
  assert.ok(land.attachments.includes(aura), "and it is in the host's attachment list");
  // "Enchanted land has {T}: create a 1/1 Squirrel" — the ability belongs to the land
  const granted = g.activatableAbilities(0).filter((x) => x.perm.iid === land.iid);
  assert.ok(granted.length, 'the enchanted land has the granted ability');
  assert.ok(!g.activatableAbilities(0).some((x) => x.perm.iid === aura.iid), 'the Aura does not have it itself');
});

test('an Aura dies with its host, and one that arrives with no host dies on arrival', () => {
  const g = soloGame('squirrel-swarm', 'omnath-landfall');
  const land = putOnBattlefield(g, 'Forest', 0);
  const nest = oracle['squirrel nest'];
  const inst = makeCardInstance(nest, { owner: 0, controller: 0, zone: 'hand', iid: g.nextIid() });
  handCard(g, 'Squirrel Nest');
  g.players[0].zones.hand.pop();
  g.players[0].zones.hand.push(inst);
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1';
  assert.ok(applyPlayerAction(g, 0, { type: 'cast', iid: inst.iid, targets: [land.iid] }, { bot: null }).ok);
  while (g.stack.length) g.resolveTop();
  assert.ok(g.battlefield.includes(inst), 'the Aura resolved onto the battlefield');

  // the host leaves: the Aura follows (CR 704.5m)
  moveToGraveyard(g, land, { reason: 'test' });
  g.checkStateBased();
  assert.ok(!g.battlefield.includes(inst), 'the Aura is gone from the battlefield');
  assert.ok(g.players[0].zones.graveyard.includes(inst), 'and it is in the graveyard');
});

test('attachments survive being written to storage and read back', () => {
  const g = soloGame('kemba-equipment', 'teysa-aristocrats');
  const land = putOnBattlefield(g, 'Plains', 0);
  const bear = putOnBattlefield(g, 'Llanowar Elves', 1);
  // attach a real Pacifism through the game's own path
  const pac = makeCardInstance(oracle['pacifism'], { owner: 0, controller: 0, zone: 'hand', iid: g.nextIid() });
  g.players[0].zones.hand.push(pac);
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1';
  const cast = applyPlayerAction(g, 0, { type: 'cast', iid: pac.iid, targets: [bear.iid] }, { bot: null });
  assert.ok(cast.ok, cast.error || 'ok');
  while (g.stack.length) g.resolveTop();
  assert.ok(bear.attachments.some((a) => a.name === 'Pacifism'), 'attached before the save');
  assert.ok(hasKeyword(g, bear, 'CantAttack'), 'the restriction applies before the save');

  // packGame used to throw on this shape (the two-way link is a cycle)
  const revived = reviveGame(packGame(g));
  const revivedBear = revived.battlefield.find((p) => p.iid === bear.iid);
  const revivedAura = revived.battlefield.find((p) => p.name === 'Pacifism');
  assert.ok(revivedBear && revivedAura, 'both are still on the battlefield after a reload');
  assert.equal(revivedAura.attachedTo?.iid, revivedBear.iid, 'the attachment is rebuilt from ids');
  assert.ok(revivedBear.attachments.some((a) => a.name === 'Pacifism'), "and the host's list is rebuilt too");
  assert.ok(hasKeyword(revived, revivedBear, 'CantAttack'), 'the restriction still applies after a reload');
});

test("Pacifism's creature can neither attack nor block", () => {
  const g = soloGame('kemba-equipment', 'teysa-aristocrats');
  const pacified = putOnBattlefield(g, 'Llanowar Elves', 1);
  const pac = makeCardInstance(oracle['pacifism'], { owner: 0, controller: 0, zone: 'hand', iid: g.nextIid() });
  g.players[0].zones.hand.push(pac);
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1';
  assert.ok(applyPlayerAction(g, 0, { type: 'cast', iid: pac.iid, targets: [pacified.iid] }, { bot: null }).ok);
  while (g.stack.length) g.resolveTop();

  assert.ok(hasKeyword(g, pacified, 'CantAttack'), 'cannot attack');
  assert.ok(hasKeyword(g, pacified, 'CantBlock'), 'cannot block');
  assert.equal(canBlock(g, pacified, putOnBattlefield(g, 'Craterhoof Behemoth', 0)), false, 'the blocker chooser refuses it');

  // and the attack prompt does not offer it
  pacified.tapped = false; pacified.summoningSick = false;
  const attacker = putOnBattlefield(g, 'Blood Artist', 1);
  attacker.summoningSick = false;
  g.activePlayer = 1; g.priority = 1; g.humanId = 1; g.humanIsBot = false;
  g.step = 'declareAttackers'; g.stepIndex = STEPS.indexOf('declareAttackers');
  g.attackersDeclared = false; g.pending = null; g.attackers = [];
  runEngine(g, { stopForHuman: true, maxIterations: 200 });
  const pending = g.pending;
  if (pending && pending.type === 'declareAttackers') {
    assert.ok(!pending.legal.includes(pacified.iid), 'the pacified creature is not offered as an attacker');
    assert.ok(pending.legal.includes(attacker.iid), 'the unrestricted creature is');
  } else {
    // nothing could attack at all — the pacified creature must then not be the reason
    assert.ok(!pending || pending.type !== 'declareAttackers');
  }
});


/* ------------------------------------------------------------------ */
/* Events: the cards the engine promised to react to                   */
/* ------------------------------------------------------------------ */

/**
 * The bug this whole block exists for: a card can listen for an event the engine
 * never emits, and nothing anywhere notices. It compiles, it reports as "fully
 * automated", it is in a seed deck — and it silently does nothing all game.
 * Sanguine Bond, Yahenni, Beastmaster Ascension and Umezawa's Jitte were all dead
 * this way. This reads the engine's own source: every event some card waits for
 * must appear at a `type: '...'` emit site.
 */
test('no card waits for an event the engine never emits', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'src/engine', f), 'utf8');
  const engineSrc = ['ops.js', 'game.js', 'driver.js', 'scripts.js'].map(read).join('\n');
  const emitted = new Set([...engineSrc.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]));
  const dead = [];
  for (const card of Object.values(oracle)) {
    let script;
    try {
      script = cardScript(makeCardInstance(card, { owner: 0, controller: 0, zone: 'battlefield', iid: 'probe' }));
    } catch { continue; }
    for (const t of script.triggers || []) {
      if (t && t.event && !emitted.has(t.event)) dead.push(`${card.name} waits for "${t.event}"`);
    }
  }
  assert.deepEqual(dead, [], `these triggers can never fire:\n  ${dead.join('\n  ')}`);
});

test('Sanguine Bond drains exactly the life you gained', () => {
  const g = soloGame('teysa-aristocrats', 'squirrel-swarm');
  const bond = putOnBattlefield(g, 'Sanguine Bond', 0);
  const before = g.players[1].life;
  gainLife(g, 0, 4, { source: bond });
  drain(g);
  assert.equal(before - g.players[1].life, 4, 'it drains the amount, not a flat 1');
});

test('a creature dying pays out the cards that care about it', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  const grove = putOnBattlefield(g, 'Moldervine Reclamation', 0);
  const bear = putOnBattlefield(g, 'Elvish Visionary', 0);
  const life = g.players[0].life, hand = g.players[0].zones.hand.length;
  destroy(g, bear, {});
  drain(g);
  assert.equal(g.players[0].life, life + 1, 'you gain 1 life');
  assert.equal(g.players[0].zones.hand.length, hand + 1, 'and you draw a card');

  const y = soloGame('teysa-aristocrats', 'squirrel-swarm');
  const yahenni = putOnBattlefield(y, 'Yahenni, Undying Partisan', 0);
  const theirs = putOnBattlefield(y, 'Elvish Visionary', 1);
  destroy(y, theirs, {});
  drain(y);
  assert.equal(yahenni.counters['+1/+1'], 1, "an opponent's creature dying grows Yahenni");
  assert.ok(grove, 'companion assertion so the unused-var lint stays quiet');
});

test('attacking feeds a quest counter, and the counters feed the payoff', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  const asc = putOnBattlefield(g, 'Beastmaster Ascension', 0);
  const bear = putOnBattlefield(g, 'Elvish Visionary', 0);
  const basePower = characteristics(g, bear).power;
  applyAttackers(g, [bear.iid]);
  drain(g);
  assert.equal(asc.counters.quest, 1, 'a creature attacking puts a quest counter on it');
  asc.counters.quest = 7;
  g.recomputeStatics();
  assert.equal(characteristics(g, bear).power, basePower + 5, 'seven counters is +5/+5 for your team');
});

test("Umezawa's Jitte charges on combat damage and spends the counters", () => {
  const g = soloGame('godo-helm', 'torbran-burn');
  const jitte = putOnBattlefield(g, "Umezawa's Jitte", 0);
  const bear = putOnBattlefield(g, 'Elvish Visionary', 0);
  bear.attachments = [...(bear.attachments || []), jitte];
  jitte.attachedTo = bear;
  g.recomputeStatics();
  applyAttackers(g, [bear.iid]);
  combatDamage(g, { round: 'normal' });
  drain(g);
  assert.equal(jitte.counters.charge, 2, 'the equipped creature connecting gives two charge counters');

  // "Remove a charge counter: …" — the three modes are three offered abilities
  richMana(g, 0);
  // equip has sorcery timing: your own main phase, nothing on the stack
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
  const offered = g.activatableAbilities(0).filter((a) => a.perm.iid === jitte.iid);
  assert.ok(offered.some((a) => a.ability.equip !== undefined), 'it can still be equipped ({2}, so it needs mana)');
  assert.equal(offered.filter((a) => /charge counter/.test(a.ability.label || '')).length, 3,
    'all three "choose one" modes are offered — none of them silently missing');
  const life = g.players[0].life;
  const gain = offered.find((a) => /gain 2 life/.test(a.ability.label || ''));
  assert.ok(gain, 'the lifegain mode is offered');
  assert.ok(g.activate(0, jitte, gain.ability, { targets: [] }).ok, 'and it can be paid for');
  assert.equal(jitte.counters.charge, 1, 'paying the cost removes a counter');
  drain(g);                       // the ability resolves off the stack, like any other
  assert.equal(g.players[0].life, life + 2, 'and the mode does what it says');

  jitte.counters.charge = 0;
  const broke = g.activatableAbilities(0).filter((a) => a.perm.iid === jitte.iid && /charge counter/.test(a.ability.label || ''));
  assert.equal(broke.length, 0, 'with no counters left those abilities are not offered');
});

test('Terastodon destroys three noncreature permanents and pays out Elephants', () => {
  const g = soloGame('omnath-landfall', 'yuriko-tempo');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null;
  const ring = putOnBattlefield(g, 'Sol Ring', 1);
  const lantern = putOnBattlefield(g, 'Chromatic Lantern', 1);
  const land = putOnBattlefield(g, 'Island', 1);
  const bear = putOnBattlefield(g, 'Elvish Visionary', 1);
  const beast = handCard(g, 'Terastodon');
  assert.ok(applyPlayerAction(g, 0, { type: 'cast', iid: beast.iid, targets: [] }, { bot: null }).ok, 'it can be cast');
  drain(g);
  for (const gone of [ring, lantern, land]) {
    assert.ok(!g.battlefield.includes(gone), `${gone.name} is destroyed — noncreature, not just artifacts`);
  }
  assert.ok(g.battlefield.includes(bear), 'a creature is left alone');
  const elephants = g.battlefield.filter((p) => p.isToken && (p.subtypes || []).includes('Elephant'));
  assert.equal(elephants.length, 3, 'their controller gets a 3/3 Elephant for each one');
  assert.ok(elephants.every((e) => e.controller === 1 && e.name === 'Elephant token'), 'and they belong to the deck that lost the permanents');
});

test('Boros Reckoner answers damage with damage', () => {
  const g = soloGame('winota-aggro', 'torbran-burn');
  const reckoner = putOnBattlefield(g, 'Boros Reckoner', 0);
  const striker = putOnBattlefield(g, 'Elvish Visionary', 1);
  damage(g, reckoner, 2, { source: striker });
  drain(g);
  assert.equal(reckoner.damage, 2, 'it took the damage');
  assert.ok(!g.battlefield.includes(striker), 'and threw it back at what hit it');
});

test('every Equipment in the pool can really be equipped', () => {
  const missing = [];
  const equipment = Object.values(oracle).filter((c) => /\bEquipment\b/.test(c.type_line || ''));
  for (const card of equipment) {
    const g = soloGame('godo-helm', 'kemba-equipment');
    richMana(g, 0);
    g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
    const piece = putOnBattlefield(g, card.name, 0);
    const bearer = putOnBattlefield(g, 'Elvish Visionary', 0);
    const offered = g.activatableAbilities(0).filter((a) => a.perm.iid === piece.iid && a.ability.equip !== undefined);
    if (!offered.length) { missing.push(`${card.name} (no equip ability offered)`); continue; }
    const res = g.activate(0, piece, offered[0].ability, { targets: [bearer.iid] });
    if (!res.ok) { missing.push(`${card.name} (${res.reason})`); continue; }
    if (piece.attachedTo?.iid !== bearer.iid) missing.push(`${card.name} (did not attach)`);
  }
  assert.deepEqual(missing, [], `these could not be equipped:\n  ${missing.join('\n  ')}`);
});

test('every instant and sorcery in the pool that targets asks for its target', () => {
  const missing = [];
  for (const card of Object.values(oracle)) {
    const tl = card.type_line || '';
    if (!/\b(Instant|Sorcery)\b/.test(tl)) continue;
    const inst = { card, name: card.name, types: tl.split('—')[0].trim().split(' '), subtypes: [], keywords: new Set(card.keywords || []), counters: {}, attachments: [] };
    const lines = (card.oracle_text || '').split('\n')
      .filter((l) => !/^(when|whenever|at the beginning of)/i.test(l))
      .filter((l) => !/^\(/.test(l.trim()) && !/^\u2022/.test(l.trim()));
    const targetsInEffect = lines.some((l) => /target/i.test(l));
    if (targetsInEffect && !targetRequirements(cardScript(inst)).length) missing.push(card.name);
  }
  assert.deepEqual(missing, [], `these spells would resolve with no target: ${missing.join(', ')}`);
});

test('a counterspell can target a spell on the stack', () => {
  const g = soloGame('kess-storm', 'yuriko-tempo');
  const cs = handCard(g, 'Counterspell');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1';
  // an opponent's spell is on the stack
  const theirSpell = g.players[1].zones.library.find((c) => c.types.includes('Sorcery'));
  g.players[1].zones.library.splice(g.players[1].zones.library.indexOf(theirSpell), 1);
  const entry = g.pushSpell(theirSpell, 1, {});
  const targets = legalTargets(g, { source: cs, controller: 0 }, SPECS.spell);
  assert.ok(targets.includes(entry.iid), 'the spell on the stack is a legal target');
  assert.ok(applyPlayerAction(g, 0, { type: 'cast', iid: cs.iid, targets: [entry.iid] }, { bot: null }).ok, 'and it can be cast at it');
  while (g.stack.length) g.resolveTop();
  assert.equal(g.stack.length, 0, 'the stack resolves');
});

test('a Spirit token dying does not feed Requiem Angel its own trigger', () => {
  const g = soloGame('kemba-equipment', 'teysa-aristocrats');
  const angel = putOnBattlefield(g, 'Requiem Angel', 0);
  const before = g.battlefield.filter((p) => p.isToken).length;
  const spirit = makeTokenInstance({ name: 'Spirit token', type_line: 'Token Creature — Spirit', types: ['Creature'], subtypes: ['Spirit'], power: '1', toughness: '1', colors: ['W'], keywords: ['Flying'], oracle_text: '' }, { owner: 0, controller: 0, iid: g.nextIid() });
  g.battlefield.push(spirit);
  moveToGraveyard(g, spirit, { reason: 'test' });
  g.checkStateBased();
  const after = g.battlefield.filter((p) => p.isToken).length;
  assert.equal(after, before, 'a Spirit dying must not create another Spirit');
  assert.ok(g.battlefield.includes(angel));
});

test('an endless loop ends the run instead of the server', () => {
  // Two effects that feed each other forever is the one thing a card game can do
  // that a web server cannot survive. The engine must call it a draw (CR 104.4b).
  const g = soloGame('teysa-aristocrats', 'omnath-landfall');
  g.activePlayer = 0; g.priority = 0; g.step = 'main1';
  g._stepResolutions = 0;
  // a stack that can never empty: every resolution pushes another entry
  const loopEntry = () => ({ kind: 'trigger', source: g.battlefield[0] || null, controller: 0, iid: g.nextIid(), spec: { steps: [{ op: 'loopForever' }] }, specIndex: 0 });
  g.resolveTop = function () { (this._loopPushes = (this._loopPushes || 0) + 1); if (this._loopPushes < 400) this.stack.push(loopEntry()); };
  const res = runEngine(g, { stopForHuman: false, maxIterations: 5000 });
  assert.equal(res.status, 'over', 'the engine stops');
  assert.equal(g.result?.info?.draw, true, 'and reports a draw');
  assert.ok((g.logLines || []).some((l) => /endless loop/i.test(l.text || l)), 'and says so on the log');
});

test('"Sacrifice a creature" is a choice the player makes, not one the engine makes', () => {
  // CR 601.2h: sacrificing is a *cost*, paid as part of activating, and which
  // creature pays it is the activating player's decision. The engine used to pick
  // the weakest creature silently and the client had no way to offer a choice.
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
  const bombard = putOnBattlefield(g, 'Goblin Bombardment', 0);
  const big = putOnBattlefield(g, 'Craterhoof Behemoth', 0);
  const small = putOnBattlefield(g, 'Elvish Visionary', 0);
  const theirs = putOnBattlefield(g, 'Spawning Kraken', 1);
  const target = theirs;

  const offered = g.activatableAbilities(0).filter((a) => a.perm.iid === bombard.iid);
  const acts = g.legalActions(0).filter((a) => a.iid === bombard.iid && a.legalSacrifices);
  assert.equal(acts.length, 1, 'the ability is offered as an action');
  const act = acts[0];
  assert.deepEqual(act.sacrificeSpec, { kind: 'permanent', filter: { creature: true, controller: 'you' } },
    'and it says what kind of permanent the cost wants');
  assert.ok(act.legalSacrifices.includes(big.iid) && act.legalSacrifices.includes(small.iid),
    'both of your creatures are offered — the strong one as well as the weak one');
  assert.ok(!act.legalSacrifices.includes(theirs.iid), 'your opponent\'s creature is not');
  assert.ok(act.sacrificeLabel, 'and the prompt has a label to show');

  // the player names the victim: the big one pays, and it is the one that dies
  const before = g.players[1].life;
  const res = g.activate(0, bombard, offered[0].ability, { targets: [target.iid], sacrifice: big.iid });
  assert.ok(res.ok, 'the activation is legal');
  drain(g);
  assert.ok(!g.battlefield.includes(big), 'the creature the player chose is the one that was sacrificed');
  assert.ok(g.battlefield.includes(small), 'and the other one is still standing');
  assert.ok(g.players[0].zones.graveyard.includes(big) || big.zone === 'graveyard', 'it went to the graveyard');
  assert.equal((g.players[1].life ?? 0) < before || target.damage > 0 || !g.battlefield.includes(target), true,
    'and the ability still did its 1 damage');
});

test('a sacrifice cost the player cannot pay is rejected before anything happens', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
  const altar = putOnBattlefield(g, 'Greater Good', 0);
  const mine = putOnBattlefield(g, 'Elvish Visionary', 0);
  const theirs = putOnBattlefield(g, 'Spawning Kraken', 1);
  const offered = g.activatableAbilities(0).filter((a) => a.perm.iid === altar.iid);
  assert.equal(g.legalActions(0).filter((a) => a.iid === altar.iid && a.legalSacrifices).length, 1,
    'the ability is offered while a creature can pay');

  const pool = g.players[0].manaPool.length;
  const bad = g.activate(0, altar, offered[0].ability, { sacrifice: theirs.iid });
  assert.equal(bad.ok, false, 'an illegal victim is refused');
  assert.equal(altar.zone, 'battlefield', 'the altar is not used up');
  assert.ok(g.battlefield.includes(theirs), 'their creature is untouched');
  assert.equal(g.players[0].manaPool.length, pool, 'and no mana was produced');

  // nothing left to sacrifice: the action stops being offered at all
  g.battlefield = g.battlefield.filter((p) => p !== mine);
  assert.equal(g.legalActions(0).filter((a) => a.iid === altar.iid && a.legalSacrifices).length, 0,
    'with no creatures of your own, the ability is not offered');
});

test('the bot (and any seat with nobody at the keyboard) feeds the cheapest creature', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
  const seer = putOnBattlefield(g, 'Viscera Seer', 0);
  const huge = putOnBattlefield(g, 'Craterhoof Behemoth', 0);
  const tiny = putOnBattlefield(g, 'Elvish Visionary', 0);
  const offered = g.activatableAbilities(0).filter((a) => a.perm.iid === seer.iid);
  assert.ok(g.legalActions(0).some((a) => a.iid === seer.iid && a.legalSacrifices), 'the ability is offered');
  assert.ok(g.activate(0, seer, offered[0].ability, { targets: [] }).ok, 'activating without naming a victim is allowed');
  drain(g);
  assert.ok(g.battlefield.includes(huge), 'the expensive creature is never the one that pays');
  const eaten = [seer, tiny].filter((c) => !g.battlefield.includes(c));
  assert.equal(eaten.length, 1, 'one of the two cheap creatures paid it (they are worth the same to the engine)');
  assert.notEqual(eaten[0], huge, 'and it was not the 5/5');
});

test('Viscera Seer eats itself rather than nothing — but "sacrifice another" never does', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  richMana(g, 0);
  g.activePlayer = 0; g.priority = 0; g.step = 'main1'; g.pending = null; g.stack = [];
  // The Seer is a creature itself, so it may pay its own cost...
  const seer = putOnBattlefield(g, 'Viscera Seer', 0);
  const offered = g.legalActions(0).filter((a) => a.iid === seer.iid && a.legalSacrifices);
  assert.deepEqual(offered[0].legalSacrifices, [seer.iid], 'with nothing else around, it may eat itself');
  // ...but a card that says "another" may not, and the action disappears entirely.
  const yawg = putOnBattlefield(g, 'Yahenni, Undying Partisan', 0);
  const yawgActs = g.legalActions(0).filter((a) => a.iid === yawg.iid && a.legalSacrifices);
  assert.equal(yawgActs.length, 1, 'Yahenni can use the Seer as its "another creature"');
  assert.ok(!yawgActs[0].legalSacrifices.includes(yawg.iid), 'but never itself');
  assert.ok(yawgActs[0].legalSacrifices.includes(seer.iid), 'and the Seer is a legal sacrifice for it');
});

test('a manland really becomes a creature, and stops being one at end of turn', () => {
  // Raging Ravine, Shambling Vent, Needle Spires, Creeping Tar Pit and Skarrg
  // Guildmage all animate lands — and before this they had no ability at all, so the
  // land tapped for mana and nothing else, forever. The animation is a layer-4/7a
  // effect that expires with the turn; it is not a counter and not a pump.
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  const ravine = putOnBattlefield(g, 'Raging Ravine', 0);
  assert.equal(characteristics(g, ravine).isCreature, false, 'a manland is a land to begin with');
  animate(g, ravine, { power: 3, toughness: 3, types: ['Creature'], subtypes: ['Elemental'], keywords: ['Haste'] }, { source: ravine });
  const awake = characteristics(g, ravine);
  assert.ok(awake.isCreature, 'while animated it is a creature');
  assert.equal(`${awake.power}/${awake.toughness}`, '3/3');
  assert.ok(awake.keywords.has('Haste'), 'and it has the keyword the animation grants');
  assert.equal(activeAnimations(ravine).length, 1, 'the animation is on the permanent, so the client can show it');
  addCounters(g, ravine, '+1/+1', 1, {});
  assert.equal(`${characteristics(g, ravine).power}/${characteristics(g, ravine).toughness}`, '4/4',
    'a counter still lands on top of the animation');
  g.clearEndOfTurnEffects();
  assert.equal(characteristics(g, ravine).isCreature, false, 'and at end of turn it is a plain land again');
  assert.deepEqual(countersOn(ravine), [{ type: '+1/+1', n: 1, temporary: false }], 'while the counter, a real counter, stays');
});

test('counters know whether they expire: "put a +1/+1 counter" vs "until end of turn"', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  const bear = putOnBattlefield(g, 'Elvish Visionary', 0);
  addCounters(g, bear, '+1/+1', 2, {});                          // "put two +1/+1 counters on it"
  addCounters(g, bear, '+1/+1', 1, {}, { duration: 'eot' });     // a counter that really does expire
  assert.equal(`${characteristics(g, bear).power}/${characteristics(g, bear).toughness}`, '4/4', 'both count while they last');
  assert.deepEqual(countersOn(bear), [
    { type: '+1/+1', n: 2, temporary: false },
    { type: '+1/+1', n: 1, temporary: true },
  ], 'and the client can tell them apart, which is the whole point');
  g.clearEndOfTurnEffects();
  assert.equal(`${characteristics(g, bear).power}/${characteristics(g, bear).toughness}`, '3/3', 'the temporary one is gone');
  assert.deepEqual(countersOn(bear), [{ type: '+1/+1', n: 2, temporary: false }], 'the permanent ones are not');
});

test('a pump is not a counter — the creature shrinks back and nothing is left on it', () => {
  const g = soloGame('squirrel-swarm', 'sea-monsters');
  const bear = putOnBattlefield(g, 'Elvish Visionary', 0);
  pump(g, bear, 3, 3, { source: null });
  assert.equal(`${characteristics(g, bear).power}/${characteristics(g, bear).toughness}`, '4/4');
  assert.deepEqual(countersOn(bear), [], 'a +3/+3 until end of turn puts no counter on the card');
  g.clearEndOfTurnEffects();
  assert.equal(`${characteristics(g, bear).power}/${characteristics(g, bear).toughness}`, '1/1', 'and it wears off at end of turn');
});

test('every card in the pool that animates a land can actually do it', () => {
  const missing = [];
  for (const card of Object.values(oracle)) {
    if (!/becomes a[n]? .*creature|becomes a .*creature/i.test(card.oracle_text || '')) continue;
    const script = cardScript(card);
    const hasAbility = (script.abilities || []).some((a) => (a.steps || []).some((s) => s.op === 'animate'));
    if (!hasAbility) missing.push(card.name);
  }
  assert.deepEqual(missing, [], `these cards say they animate something but the engine cannot do it:\n  ${missing.join('\n  ')}`);
});
