/**
 * Daily challenge logic.
 *
 * The clock: the game day rolls at 01:00 America/New_York (EST/EDT), so a
 * "day" runs 1am -> 1am Eastern. Everything is derived from that key, which
 * means every player in every timezone gets the identical puzzle.
 *
 * Same starting point for everyone: the seed is a hash of the day key, so
 * deck selection, shuffles, opening hands and the scripted opening turns are
 * byte-identical for all players. There is no way to reroll: the run lives
 * server-side keyed to the session token.
 */
import { hashSeed } from '../engine/rng.js';
import { loadAllDecks } from '../decks/index.js';
import { deckFromRecord } from './verifyDeck.js';
import * as store from './store.js';

/**
 * The rotation pool: the hand-built seed decks plus every verified community
 * upload. Community decks are stored as plain lists and rebuilt here, so they
 * take exactly the same code path as the seeds (and a deck can never be in the
 * pool in a shape the engine did not just normalise).
 *
 * Ordering is stable — seeds first, then community decks sorted by id — because
 * every pool that feeds the daily must be identical on every instance, or the
 * same day would produce different puzzles for different players.
 */
/** The UTC instant at which a given day began (01:00 ET on that date). */
export function dayStartMs(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const probe = Date.UTC(y, m - 1, d, 6, 0, 0); // 1am ET is 05:00Z in summer, 06:00Z in winter
  for (let offset = -3 * 3600e3; offset <= 3 * 3600e3; offset += 900e3) {
    const cand = new Date(probe + offset);
    const p = etParts(cand);
    if (p.y === y && p.m === m && p.d === d && p.h === RESET_HOUR_ET && p.min === 0) return cand.getTime();
  }
  return probe;
}

/**
 * Everything that may be drawn into a game.
 *
 * Passing a day key freezes the pool at that day's 01:00 ET reset: a deck
 * uploaded at lunchtime must not change the matchup everyone else already
 * started this morning, or the day would not be a shared, comparable puzzle.
 * With no day key the pool is live — that is what practice uses, so a freshly
 * uploaded deck can be played immediately.
 */
export function rotationPool(dayKey = null) {
  const seeds = loadAllDecks();
  const cutoff = dayKey ? dayStartMs(dayKey) : Infinity;
  let community = [];
  try {
    community = store.communityDecks()
      .filter((r) => r && r.verified && r.spells && r.commander)
      .filter((r) => {
        const at = Date.parse(r.addedAt || '');
        if (!dayKey || !Number.isFinite(at)) return true; // no timestamp: treat as always eligible
        return at < cutoff;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((r) => {
        try { return deckFromRecord(r); } catch { return null; } // a deck that no longer builds is skipped, not fatal
      })
      .filter(Boolean);
  } catch { community = []; }
  return [...seeds, ...community];
}

export const RESET_HOUR_ET = 1;

const TZ = 'America/New_York';

/** Parts of `date` in Eastern time. */
function etParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, min: +parts.minute, s: +parts.second };
}

/** The current game day key, e.g. "2026-10-15". Rolls over at 01:00 ET. */
export function dayKeyFor(date = new Date()) {
  const p = etParts(date);
  const shifted = new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s));
  if (p.h < RESET_HOUR_ET) shifted.setUTCDate(shifted.getUTCDate() - 1);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** Milliseconds until the next 01:00 ET rollover. */
export function msUntilReset(date = new Date()) {
  const p = etParts(date);
  // Build the next 1am ET as a wall-clock target, then find its UTC instant by
  // iterating (DST-safe, and only ever a couple of iterations).
  const target = { y: p.y, m: p.m, d: p.d };
  if (!(p.h < RESET_HOUR_ET)) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
    d.setUTCDate(d.getUTCDate() + 1);
    target.y = d.getUTCFullYear(); target.m = d.getUTCMonth() + 1; target.d = d.getUTCDate();
  }
  const probe = Date.UTC(target.y, target.m - 1, target.d, 6, 0, 0); // 1am ET ≈ 06:00Z in winter
  for (let offset = -3 * 3600e3; offset <= 3 * 3600e3; offset += 900e3) {
    const cand = new Date(probe + offset);
    const cp = etParts(cand);
    if (cp.y === target.y && cp.m === target.m && cp.d === target.d && cp.h === RESET_HOUR_ET && cp.min === 0) {
      const ms = cand.getTime() - date.getTime();
      if (ms > 0) return ms;
    }
  }
  // fallback: ~next day
  return 24 * 3600e3 - ((p.h - RESET_HOUR_ET + 24) % 24) * 3600e3;
}

const BRACKET_ROTATION = [2, 1, 3, 2, 4, 1, 3, 2, 5, 1, 3, 4, 2, 1, 3]; // day-of-year → bracket

/**
 * The day's matchup: bracket, both decks, which seat the human plays, and the
 * point at which control is handed over.
 * Deck names come from the public vote when there is a clear winner.
 */
export function dailySetup(dayKey) {
  const decks = rotationPool(dayKey);
  const seed = hashSeed(`commander-daily:v1:${dayKey}`);
  const rng = mulberry(seed);

  const [y, m, d] = dayKey.split('-').map(Number);
  const dayOfYear = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
  const bracket = BRACKET_ROTATION[dayOfYear % BRACKET_ROTATION.length];
  const pool = decks.filter((x) => x.bracket === bracket);

  const votes = store.tallyVotes(previousDayKey(dayKey));
  const voted = store.winningVote(previousDayKey(dayKey));
  const votedDeck = voted ? decks.find((x) => x.id === voted) : null;

  let a; let b;
  if (votedDeck) {
    const others = pool.filter((x) => x.id !== votedDeck.id);
    a = votedDeck;
    b = pick(others.length ? others : pool.filter((x) => x.id !== votedDeck.id), rng);
    if (!b) b = decks.find((x) => x.id !== votedDeck.id);
  } else {
    // deterministic pair from the seed: a "shuffled deck, then take two"
    const shuffled = shuffle([...pool], rng);
    // avoid repeating yesterday's exact pairing when the pool allows
    const yesterday = yesterdayPairing(dayKey, decks);
    let idx = 0;
    a = shuffled[idx % shuffled.length];
    b = shuffled[(idx + 1) % shuffled.length];
    if (yesterday && a.id === yesterday.a && b.id === yesterday.b && shuffled.length > 2) {
      b = shuffled[(idx + 2) % shuffled.length];
    }
  }

  const humanIsA = rng() < 0.5;
  const humanDeck = humanIsA ? a : b;
  const botDeck = humanIsA ? b : a;

  // How much of the game the bot plays for you before you take over.
  const openingTurns = { 1: 4, 2: 4, 3: 3, 4: 3, 5: 2 }[botDeck.bracket] ?? 3;

  return {
    dayKey, seed, bracket,
    decks: [humanDeck, botDeck],
    humanDeck: { id: humanDeck.id, name: humanDeck.name, bracket: humanDeck.bracket, commander: humanDeck.commander, blurb: humanDeck.blurb },
    botDeck: { id: botDeck.id, name: botDeck.name, bracket: botDeck.bracket, commander: botDeck.commander, theme: botDeck.theme, themeName: botDeck.themeName, blurb: botDeck.blurb, prototype: botDeck.prototype },
    openingTurns,
    voteTally: votes,
  };
}

function yesterdayPairing(dayKey, decks) {
  try {
    const prev = previousDayKey(dayKey);
    const seed = hashSeed(`commander-daily:v1:${prev}`);
    const rng = mulberry(seed);
    const [y, m, d] = prev.split('-').map(Number);
    const dayOfYear = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
    const bracket = BRACKET_ROTATION[dayOfYear % BRACKET_ROTATION.length];
    const pool = decks.filter((x) => x.bracket === bracket);
    const sh = shuffle([...pool], rng);
    if (sh.length < 2) return null;
    const voted = store.winningVote(previousDayKey(prev));
    if (voted) return null;
    return { a: sh[0].id, b: sh[1].id };
  } catch { return null; }
}

/** The three decks players choose between for tomorrow (+ the random option). */
export function voteOptions(dayKey) {
  const nextKey = nextDayKey(dayKey);
  const decks = rotationPool(nextKey);
  const seed = hashSeed(`commander-vote:v1:${nextKey}`);
  const rng = mulberry(seed);
  const [y, m, d] = nextKey.split('-').map(Number);
  const dayOfYear = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
  const bracket = BRACKET_ROTATION[dayOfYear % BRACKET_ROTATION.length];
  const pool = decks.filter((x) => x.bracket === bracket);
  // Always offer three choices: top up from the nearest brackets when the
  // bracket pool is thin (our seed pool has two decks per bracket).
  const extras = decks.filter((x) => x.bracket !== bracket)
    .sort((x, y) => Math.abs(x.bracket - bracket) - Math.abs(y.bracket - bracket));
  const three = shuffle([...pool], rng).slice(0, 3);
  for (const e of shuffle([...extras], rng)) {
    if (three.length >= 3) break;
    three.push(e);
  }
  return {
    nextKey, bracket,
    options: three.map((x) => ({ id: x.id, name: x.name, bracket: x.bracket, commander: x.commander, blurb: x.blurb, theme: x.theme })),
    includeRandom: true,
  };
}

export function practiceSetup(seed, excludeIds = []) {
  const decks = rotationPool(); // live pool: practice may use a deck the moment it verifies
  const rng = mulberry(seed);
  const pool = decks.filter((x) => !excludeIds.includes(x.id));
  const brackets = [...new Set(pool.map((x) => x.bracket))];
  const bracket = pick(brackets, rng);
  let choices = pool.filter((x) => x.bracket === bracket);
  if (choices.length < 2) choices = pool;
  const shuffled = shuffle([...choices], rng);
  const a = shuffled[0];
  const b = shuffled[1] || decks.find((x) => x.id !== a.id);
  const humanIsA = rng() < 0.5;
  const humanDeck = humanIsA ? a : b;
  const botDeck = humanIsA ? b : a;
  const openingTurns = { 1: 4, 2: 4, 3: 3, 4: 3, 5: 2 }[botDeck.bracket] ?? 3;
  return {
    seed, bracket,
    decks: [humanDeck, botDeck],
    humanDeck: { id: humanDeck.id, name: humanDeck.name, bracket: humanDeck.bracket, commander: humanDeck.commander, blurb: humanDeck.blurb },
    botDeck: { id: botDeck.id, name: botDeck.name, bracket: botDeck.bracket, commander: botDeck.commander, theme: botDeck.theme, themeName: botDeck.themeName, blurb: botDeck.blurb, prototype: botDeck.prototype },
    openingTurns,
  };
}

/* ---------------- small deterministic helpers ---------------- */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

export function nextDayKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
export function previousDayKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export { dayKeyFor as today };
