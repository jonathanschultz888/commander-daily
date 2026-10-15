/**
 * Persistence. One document, two backends:
 *
 *   STORE_BACKEND=file     (default)  data/store.json, atomic writes
 *   STORE_BACKEND=upstash  any Redis-REST endpoint (Upstash, Vercel KV, Fly
 *                          Upstash, self-hosted REST proxy) over plain fetch
 *
 * Why a backend switch exists: the free hosting tiers that this project is
 * meant to live on (Render free, Fly trial, any serverless host) wipe the local
 * filesystem on every spin-down, restart and deploy. On those, "resume your run
 * exactly where you left off" and the leaderboard would silently reset, which
 * for a one-attempt-a-day game means the daily promise breaks. So the document
 * can live in an external KV instead, with zero extra dependencies.
 *
 * The in-memory document is always the source of truth for reads (so the rest
 * of the server keeps its synchronous API) and writes are debounced and
 * flushed to the backend. On a failed flush the write stays dirty and is
 * retried, and a boot-time load pulls the last good copy back.
 *
 * Tables:
 *   runs        - one per (token, dayKey, mode): the full engine snapshot
 *   leaderboard - submitted scores per day
 *   votes       - votes for tomorrow's deck, keyed by day
 *   sessions    - issued tokens (hashed) -> created timestamps
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'store.json');
const RAW_BACKEND = (process.env.STORE_BACKEND || 'file').toLowerCase();
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.STORE_KEY || 'commander-daily:store:v1';
const FLUSH_MS = Number(process.env.STORE_FLUSH_MS || 1500);

/** 'upstash' whenever a REST url+token are present, unless explicitly overridden. */
export const backend = KV_URL && KV_TOKEN && RAW_BACKEND !== 'file' ? 'upstash' : 'file';
if ((KV_URL || KV_TOKEN) && !(KV_URL && KV_TOKEN)) {
  console.warn('[store] KV url/token is incomplete — falling back to the file backend.');
}

const emptyStore = () => ({ runs: {}, leaderboard: [], votes: {}, sessions: {}, meta: { created: new Date().toISOString() } });

let store = emptyStore();
let dirty = false;
let timer = null;
let saving = false;
let lastSavedAt = null;
let lastError = null;

/* ------------------------------------------------------------------ */
/* Redis-REST transport (Upstash-compatible: POST ["SET", key, value]) */
/* ------------------------------------------------------------------ */

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

/* ------------------------------------------------------------------ */
/* load / flush                                                        */
/* ------------------------------------------------------------------ */

export async function load() {
  if (backend === 'upstash') {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = await kv(['GET', KV_KEY]);
        if (raw) store = { ...emptyStore(), ...JSON.parse(raw) };
        console.log(`[store] loaded from KV (${Object.keys(store.runs).length} runs, ${store.leaderboard.length} scores)`);
        return store;
      } catch (e) {
        lastError = e.message;
        console.warn(`[store] KV load failed (attempt ${attempt}/3): ${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    // Starting empty would let everyone replay the day, so say so loudly.
    console.error('[store] could not reach the KV store — starting EMPTY. Set STORE_BACKEND=file or fix KV creds.');
    return store;
  }

  try {
    if (fs.existsSync(FILE)) {
      store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    }
  } catch (e) {
    console.warn('[store] could not read store, starting fresh:', e.message);
    store = emptyStore();
  }
  return store;
}

async function writeThrough() {
  if (saving) return;
  saving = true;
  try {
    if (backend === 'upstash') {
      await kv(['SET', KV_KEY, JSON.stringify(store)]);
    } else {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, FILE);
    }
    dirty = false;
    lastSavedAt = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.warn('[store] save failed (will retry):', e.message);
    dirty = true;
    setTimeout(() => { if (dirty) save(); }, 5000);
  } finally {
    saving = false;
  }
}

/** Mark dirty and flush soon. Safe to call on every mutation. */
export function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) writeThrough(); }, FLUSH_MS);
}

/** Flush immediately — used on shutdown and by tests. */
export async function saveNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  await writeThrough();
  return true;
}

export const stats = () => ({
  backend, key: backend === 'upstash' ? KV_KEY : FILE,
  runs: Object.keys(store.runs).length, scores: store.leaderboard.length,
  sessions: Object.keys(store.sessions).length, dirty, lastSavedAt, lastError,
});

export function data() { return store; }

/**
 * Drop run snapshots whose day is no longer playable. A run only matters for
 * its own day (plus yesterday, so a late-night player who reloads at 00:59
 * still sees their result). Keeps the document bounded on a 256 MB free tier.
 */
export function pruneRuns(keepDayKeys = []) {
  const keep = new Set(keepDayKeys);
  let dropped = 0;
  for (const key of Object.keys(store.runs)) {
    const day = key.split(':')[1];
    if (day && !keep.has(day)) { delete store.runs[key]; dropped++; }
  }
  if (dropped) { save(); console.log(`[store] pruned ${dropped} old run(s)`); }
  return dropped;
}

/* ---------------- sessions ---------------- */

export function touchSession(tokenHash) {
  store.sessions[tokenHash] = store.sessions[tokenHash] || { created: new Date().toISOString(), runs: 0 };
  save();
  return store.sessions[tokenHash];
}

/* ---------------- runs ---------------- */

export const runKey = (tokenHash, dayKey, mode) => `${tokenHash}:${dayKey}:${mode}`;

export function getRun(tokenHash, dayKey, mode) {
  return store.runs[runKey(tokenHash, dayKey, mode)] || null;
}

export function putRun(tokenHash, dayKey, mode, record) {
  store.runs[runKey(tokenHash, dayKey, mode)] = { ...record, updatedAt: new Date().toISOString() };
  save();
  return store.runs[runKey(tokenHash, dayKey, mode)];
}

export function deleteRun(tokenHash, dayKey, mode) {
  delete store.runs[runKey(tokenHash, dayKey, mode)];
  save();
}

/* ---------------- leaderboard ---------------- */

export function addScore(entry) {
  store.leaderboard.push({ ...entry, submittedAt: new Date().toISOString() });
  if (store.leaderboard.length > 5000) store.leaderboard.splice(0, store.leaderboard.length - 5000);
  save();
  return entry;
}

export function scoresForDay(dayKey, limit = 100) {
  return store.leaderboard
    .filter((e) => e.dayKey === dayKey)
    .sort((a, b) => b.points - a.points || a.turns - b.turns)
    .slice(0, limit);
}

export function hasSubmitted(tokenHash, dayKey) {
  return store.leaderboard.some((e) => e.dayKey === dayKey && e.tokenHash === tokenHash);
}

export function allTime(limit = 50) {
  const byName = new Map();
  for (const e of store.leaderboard) {
    const cur = byName.get(e.name) || { name: e.name, points: 0, wins: 0, runs: 0, best: 0 };
    cur.points += e.points;
    cur.wins += e.won ? 1 : 0;
    cur.runs += 1;
    cur.best = Math.max(cur.best, e.points);
    byName.set(e.name, cur);
  }
  return [...byName.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

/* ---------------- votes ---------------- */

export function getVotes(dayKey) {
  store.votes[dayKey] = store.votes[dayKey] || {};
  return store.votes[dayKey];
}

export function castVote(dayKey, tokenHash, choice) {
  const votes = getVotes(dayKey);
  // one vote per voter per day, changeable until the day rolls over
  votes[tokenHash] = { choice, at: new Date().toISOString() };
  save();
  return votes;
}

export function tallyVotes(dayKey) {
  const votes = getVotes(dayKey);
  const counts = {};
  for (const v of Object.values(votes)) counts[v.choice] = (counts[v.choice] || 0) + 1;
  return { counts, total: Object.keys(votes).length };
}

export function winningVote(dayKey) {
  const { counts, total } = tallyVotes(dayKey);
  if (!total) return null;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [choice, count] = ranked[0];
  const tied = ranked.filter(([, c]) => c === count).length > 1;
  if (tied || choice === 'random') return null; // ties and "random" fall back to the seeded pick
  return choice;
}

export function leaderboardStats(dayKey) {
  const day = scoresForDay(dayKey, 10000);
  const total = day.length;
  const wins = day.filter((e) => e.won).length;
  const avg = total ? Math.round(day.reduce((a, e) => a + e.points, 0) / total) : 0;
  const best = day[0]?.points || 0;
  return { total, wins, winRate: total ? Math.round((wins / total) * 100) : 0, avg, best };
}
