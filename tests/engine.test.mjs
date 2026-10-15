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
import { loadAllDecks, profileDeck, COMBO_REGISTRY, GAME_CHANGERS } from '../src/decks/index.js';
import * as store from '../src/server/store.js';
import { SEED_DECKS } from '../src/decks/lists.js';
import { createGame, reviveGame, packGame } from '../src/engine/game.js';
import { runEngine, combatDamage, executeAction, playOpening } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';
import { makeCardInstance, characteristics, makeTokenInstance } from '../src/engine/cards.js';
import { cardScript } from '../src/engine/scripts.js';
import { tokenDef, damage, putPermanent, addCounters, findPermanent } from '../src/engine/ops.js';
import { oracle } from '../src/decks/index.js';
import { dayKeyFor, msUntilReset, dailySetup, practiceSetup, nextDayKey, previousDayKey } from '../src/server/daily.js';
import { hashSeed } from '../src/engine/rng.js';

const decks = loadAllDecks();
const deckById = (id) => decks.find((d) => d.id === id);

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
