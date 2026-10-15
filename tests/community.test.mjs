/**
 * Community deck pipeline: upload → verify → shared rotation.
 *
 * `npm test` points DATA_FILE at a throwaway file (see scripts/run-tests.mjs),
 * so these tests can write community decks without touching a real store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllDecks } from '../src/decks/index.js';
import { verifyDeck, deckToText, communityRecord, deckFromRecord, automationOf } from '../src/server/verifyDeck.js';
import { rotationPool, dailySetup, practiceSetup, dayKeyFor, nextDayKey } from '../src/server/daily.js';
import * as store from '../src/server/store.js';
import { oracle } from '../src/decks/index.js';

const seed = loadAllDecks().find((d) => d.id === 'teysa-aristocrats');
const seedList = () => {
  const lines = [`1 ${seed.commander}`, '', '// spells', ...seed.spells.map((s) => `1 ${s}`),
    '', '// lands', ...seed.lands.map((l) => `1 ${l}`)];
  for (const [b, n] of Object.entries(seed.basics)) lines.push(`${n} ${b}`);
  return lines.join('\n');
};

test('a real decklist verifies, and a card the engine cannot fully play is swapped out', () => {
  // The Teysa seed list contains Sifter of Skulls and Condemn, which the engine
  // only partially supports. The deck must still be admissible — but only after
  // those cards are replaced, and the substitution must be reported.
  const result = verifyDeck(seedList(), { name: 'Round trip', bracket: 3 });
  assert.ok(result.ok, 'the deck should be admissible once repaired');
  assert.ok(result.report.substitutions.length >= 1, 'the partially supported cards are reported as substitutions');
  for (const s of result.report.substitutions) {
    assert.ok(s.out && s.in && s.out !== s.in, `${s.out} must be replaced by a different card`);
  }
  assert.equal(result.report.coverage.pct, 100, 'a deck in the rotation is 100% automated');
  assert.equal(result.deck.cardList.length, 100, 'and it materialises as a full 100-card deck the engine can play');

  // Every card left in the deck must be fully automated — that is the whole bar.
  const final = verifyDeck(deckToText(result.deck), { name: 'Round trip (re-verified)', bracket: 3, repair: false });
  assert.ok(final.ok, 'the repaired list verifies without needing another repair');
  for (const card of final.report.perCard) {
    assert.notEqual(card.status, 'partial', `${card.name} is still partial`);
    assert.notEqual(card.status, 'unhandled', `${card.name} is still unhandled`);
  }
});

test('a deck whose commander is not fully scripted is rejected, not silently repaired', () => {
  // Rashmi, Eternities Crafter is a real card in the pool that the engine only
  // partially supports. A commander cannot be swapped out — the whole list is
  // built around it — so this deck must be refused rather than repaired.
  const lines = ['Commander: Rashmi, Eternities Crafter', '1 Sol Ring', '49 Island', '49 Forest'];
  const result = verifyDeck(lines.join('\n'), { name: 'Bad commander', bracket: 4 });
  assert.equal(result.ok, false, 'an unscriptable commander makes the deck unusable');
  assert.ok(result.report.blockers.some((b) => b.name === 'Rashmi, Eternities Crafter'), 'the commander is named as the blocker');
  assert.ok(result.report.checks.some((c) => !c.ok), 'and the report says which checks failed');
});

test('the pipeline rejects decks that break the rules, with the reason attached', () => {
  const cases = [
    ['too small', seedList().replace(/^\d+ (Swamp|Plains)$/gm, ''), /need exactly 100/],
    ['off colour', `${seedList()}\n1 Counterspell`, /off-colour|Colour identity/],
  ];
  for (const [label, text, pattern] of cases) {
    const result = verifyDeck(text, { name: label, bracket: 3 });
    assert.equal(result.ok, false, `${label} must be rejected`);
    const detail = result.report.checks.map((c) => `${c.label} ${c.detail}`).join(' ');
    assert.match(detail, pattern, `${label}: the report should explain the failure (${detail.slice(0, 120)})`);
  }
});

test('an upload joins the shared rotation from the next reset onwards', () => {
  const today = dayKeyFor(new Date());
  const before = dailySetup(today);

  const result = verifyDeck(seedList(), { name: 'Rotation test deck', bracket: 3 });
  assert.ok(result.ok);
  const record = communityRecord(result.deck, result.report, { id: 'community-test-deck', addedBy: 'test' });
  store.putCommunityDeck(record);

  // It is playable immediately (practice uses the live pool)...
  const live = rotationPool();
  assert.ok(live.some((d) => d.id === 'community-test-deck'), 'practice can use it straight away');
  const rebuilt = live.find((d) => d.id === 'community-test-deck');
  assert.equal(rebuilt.cardList.length, 100, 'and it is rebuilt into a playable deck, not a bare list');
  assert.equal(rebuilt.bracket, 3, 'in the bracket it declared');

  // ...and it is in the pool the *next* day will freeze.
  const tomorrow = nextDayKey(today);
  assert.ok(rotationPool(tomorrow).some((d) => d.id === 'community-test-deck'),
    'and it is eligible for tomorrow, when the vote for it would take effect');

  // Practice must still never use either of today's decks.
  const prac = practiceSetup(12345, [before.humanDeck.id, before.botDeck.id]);
  assert.ok(![before.humanDeck.id, before.botDeck.id].includes(prac.humanDeck.id));
  assert.ok(![before.humanDeck.id, before.botDeck.id].includes(prac.botDeck.id));

  store.removeCommunityDeck('community-test-deck');
  assert.ok(!rotationPool().some((d) => d.id === 'community-test-deck'), 'a withdrawn deck leaves the pool');
});

test('a deck uploaded at midday cannot change the day that is already in progress', () => {
  // Everyone must get the identical starting point: the pool is frozen at the
  // day's 01:00 ET reset, so an upload cannot re-roll today's matchup for the
  // players who have not started yet.
  const today = dayKeyFor(new Date());
  const before = dailySetup(today);
  const fingerprint = (s) => `${s.bracket}|${s.humanDeck.id}|${s.botDeck.id}|${s.seed}|${s.humanIsA}`;

  // Upload into the same bracket as today, so the pool it draws from really changes.
  const sameBracket = loadAllDecks().find((d) => d.bracket === before.bracket);
  assert.ok(sameBracket, "today's bracket has a seed deck to clone");
  const lines = [`Commander: ${sameBracket.commander}`,
    ...sameBracket.spells.map((c) => `1 ${c}`), ...sameBracket.lands.map((c) => `1 ${c}`)];
  for (const [b, n] of Object.entries(sameBracket.basics)) lines.push(`${n} ${b}`);
  const result = verifyDeck(lines.join('\n'), { name: 'Midday upload', bracket: before.bracket });
  assert.ok(result.ok, 'the clone verifies');
  store.putCommunityDeck(communityRecord(result.deck, result.report, { id: 'community-midday' }));

  assert.equal(fingerprint(dailySetup(today)), fingerprint(before),
    "today's matchup, seed and seat are unchanged by an upload");
  assert.ok(rotationPool().some((d) => d.id === 'community-midday'), 'but practice can already play it');

  // A day that has not started yet does see it.
  store.removeCommunityDeck('community-midday');
  const fresh = verifyDeck(lines.join('\n'), { name: 'Fresh', bracket: before.bracket });
  const record = communityRecord(fresh.deck, fresh.report, { id: 'community-fresh' });
  record.addedAt = new Date(Date.now() - 86_400_000 * 2).toISOString(); // as if uploaded two days ago
  store.putCommunityDeck(record);
  assert.ok(rotationPool(today).some((d) => d.id === 'community-fresh'),
    "a deck from before the day started is in that day's frozen pool");
  store.removeCommunityDeck('community-fresh');
});

test('a stored deck that no longer builds is skipped instead of breaking the daily', () => {
  store.putCommunityDeck({
    id: 'community-broken', name: 'Broken', commander: seed.commander, bracket: 3,
    spells: ['Not A Real Card'], lands: [], basics: { Plains: 1 }, verified: true,
    theme: '#000', themeName: 'x', prototype: 'midrange',
  });
  const pool = rotationPool();
  assert.ok(!pool.some((d) => d.id === 'community-broken'), 'the unbuildable record is skipped');
  const day = new Date(Date.UTC(2026, 7, 1)).toISOString().slice(0, 10);
  assert.doesNotThrow(() => dailySetup(day), 'and the daily still builds for everyone else');
  store.removeCommunityDeck('community-broken');
});

test('automationOf matches the coverage report it mirrors', () => {
  // Spot-check the classification the whole gate rests on.
  const scripted = oracle['sol ring'] || oracle[Object.keys(oracle).find((k) => k === 'sol ring')];
  if (scripted) assert.equal(automationOf(scripted).fullyAutomated, true, 'Sol Ring is fully automated');
  const partial = Object.values(oracle).find((c) => c.name === "Thassa's Oracle");
  assert.ok(partial, 'the partial example exists in the pool');
  assert.equal(automationOf(partial).fullyAutomated, false, "Thassa's Oracle is not fully automated (devotion count)");
});

test('deckFromRecord round-trips a stored record into a playable deck', () => {
  const result = verifyDeck(seedList(), { name: 'Round trip 2', bracket: 3 });
  const record = communityRecord(result.deck, result.report, { id: 'community-rt' });
  const rebuilt = deckFromRecord(record);
  assert.equal(rebuilt.cardList.length, 100);
  assert.equal(rebuilt.community, true);
  assert.deepEqual(rebuilt.spells, result.deck.spells, 'the list survives JSON via the store');
});

test('re-uploading the same list updates one slot instead of padding the pool', () => {
  // Two players pasting the same decklist is normal (it is a popular list), and
  // it must not put near-duplicates into the rotation: the daily draws two decks
  // from a small bracket pool, and twins would let a day pair a deck with itself.
  const before = rotationPool().length;
  const a = verifyDeck(seedList(), { name: 'Twin A', bracket: 3 });
  const recordA = communityRecord(a.deck, a.report, {});
  const b = verifyDeck(seedList(), { name: 'Twin B', bracket: 3 });
  const recordB = communityRecord(b.deck, b.report, {});
  assert.equal(recordA.id, recordB.id, 'the same 100 cards produce the same rotation id');

  store.putCommunityDeck(recordA);
  const afterFirst = rotationPool().length;
  assert.equal(afterFirst, before + 1, 'the first upload adds one deck');
  store.putCommunityDeck({ ...recordB, addedAt: recordA.addedAt });
  assert.equal(rotationPool().length, afterFirst, 'the twin replaces it rather than adding a second');

  const pool = rotationPool();
  const ids = pool.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'the pool has no duplicate ids');
  store.removeCommunityDeck(recordA.id);
});

test('an operator can remove a deck without a server restart', async () => {
  // Deck names and lists are public, so a bad upload has to be removable — and
  // only by the operator. With no ADMIN_TOKEN set the endpoint must refuse, so a
  // public deployment cannot be vandalised through it.
  const { spawn } = await import('node:child_process');
  const port = 3399;
  const env = { ...process.env, PORT: String(port), DATA_FILE: `/tmp/community-mod-${process.pid}.json`, SESSION_SECRET: 'x'.repeat(32) };
  const start = (withToken) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server/server.js'], {
      env: withToken ? { ...env, ADMIN_TOKEN: 'secret-token' } : env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const done = (ok) => { child.stdout.off('data', onData); ok ? resolve(child) : reject(new Error('server did not start')); };
    const onData = (b) => { if (/listening on/.test(String(b))) done(true); };
    child.stdout.on('data', onData);
    child.on('error', () => done(false));
    setTimeout(() => done(false), 5000);
  });

  const post = async (path, body) => (await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();

  // First, an unconfigured server: moderation must be closed.
  const open = await start(false);
  try {
    const refused = await post('/api/community/remove', { id: 'whatever' });
    assert.match(String(refused.error), /disabled/, 'without ADMIN_TOKEN the endpoint refuses to act');
  } finally { open.kill('SIGTERM'); }
  await new Promise((r) => setTimeout(r, 400));

  // Then with a token configured, acting only through the public API (the
  // file store is per-process memory, so a test must not write the file behind
  // a running server's back).
  const guarded = await start(true);
  try {
    const imported = await post('/api/import', { text: seedList(), name: 'To be moderated', bracket: 3, addToPool: true });
    assert.equal(imported.ok, true, 'the upload verifies');
    const id = imported.added.id;

    const list = async () => (await fetch(`http://127.0.0.1:${port}/api/community`).then((r) => r.json())).decks;
    const before = (await list()).map((d) => d.id);
    assert.ok(before.includes(id), 'the upload is in the public rotation');

    assert.equal((await post('/api/community/remove', { id, token: 'wrong' })).error, 'Forbidden');
    assert.equal((await post('/api/community/remove', { id: 'community-nope', token: 'secret-token' })).error, 'No such deck');
    const removed = await post('/api/community/remove', { id, token: 'secret-token' });
    assert.equal(removed.ok, true, 'the operator can remove a deck');
    assert.ok(!(await list()).map((d) => d.id).includes(id), 'and it is gone from the public rotation');
    assert.ok(!rotationPool().some((d) => d.id === id), 'and it can no longer be drawn into a game');
  } finally { guarded.kill('SIGTERM'); }
});

test('a malformed store cannot break a player submission', () => {
  // A hand-edited file, an older version's shape, or a half-written value used
  // to turn /api/submit into a 500. Every container is normalised on load now.
  const { normaliseStore } = store;
  const cases = [
    ['leaderboard as a map', { leaderboard: { a: { dayKey: '2026-01-01', points: 5 } } }, (s) => assert.ok(Array.isArray(s.leaderboard) && s.leaderboard.length === 1)],
    ['leaderboard as a string', { leaderboard: 'nonsense' }, (s) => assert.deepEqual(s.leaderboard, [])],
    ['runs as an array', { runs: [] }, (s) => assert.deepEqual(s.runs, {})],
    ['community null', { community: null }, (s) => assert.deepEqual(s.community, {})],
    ['everything missing', {}, (s) => {
      assert.deepEqual(s.leaderboard, []);
      assert.deepEqual(s.runs, {});
      assert.deepEqual(s.votes, {});
      assert.deepEqual(s.sessions, {});
      assert.deepEqual(s.community, {});
    }],
    ['not an object at all', null, (s) => assert.deepEqual(s.leaderboard, [])],
  ];
  for (const [label, input, check] of cases) {
    const out = normaliseStore(input);
    assert.ok(out && typeof out === 'object', `${label}: still an object`);
    check(out);
    // The shapes a submission touches must all be usable on the result.
    assert.equal(typeof out.leaderboard.push, 'function', `${label}: leaderboard is a list`);
    assert.equal(typeof out.votes, 'object', `${label}: votes is a map`);
    assert.ok(!out.leaderboard.some((e) => e.dayKey === '2026-01-01' && e.tokenHash === 'zzz'),
      `${label}: nobody has submitted for this token, so the duplicate check can run`);
  }
});
