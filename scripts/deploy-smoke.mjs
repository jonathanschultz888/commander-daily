/**
 * Deployment smoke test: proves the daily survives a restart with no local disk.
 *
 * Run it in two phases around a redeploy/spin-down, against any URL (local,
 * Render, Fly, your own box):
 *
 *   node scripts/deploy-smoke.mjs <url> phase1     # start + play, save the cookie
 *   # ...restart / redeploy / let the free tier spin the service down...
 *   node scripts/deploy-smoke.mjs <url> phase2     # resume, finish, submit, rank
 *
 * Phase 2 fails loudly if the board, hand, life totals or turn differ from
 * where phase 1 left off — that is the promise the "one attempt a day" rule
 * depends on, and the failure mode a wiped filesystem produces.
 */
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const PHASE = process.argv[3] || 'phase1';
const STATE_FILE = process.env.SMOKE_STATE || '/tmp/commander-daily-smoke.json';

let cookie = '';
async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) if (c.startsWith('cd_session=')) cookie = c.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const fingerprint = (view) => ({
  turn: view.turn,
  status: view.status,
  myLife: view.players[0].life,
  oppLife: view.players[1].life,
  hand: view.players[0].handCount,
  bf: view.battlefield.length,
  lastLog: view.log.at(-1)?.text || null,
});

/** Pick something useful and legal to do, like a player would. */
function chooseAction(pending) {
  const acts = pending?.actions || [];
  const byType = (t) => acts.filter((a) => a.type === t);
  const land = byType('playLand')[0];
  if (land) return land;
  const cheap = byType('cast').filter((a) => !a.needsX && !a.optional).sort((a, b) => a.cmc - b.cmc)[0];
  if (cheap) return { ...cheap, targets: cheap.suggestedTarget ? [cheap.suggestedTarget] : [] };
  if (byType('activate')[0]) return byType('activate')[0];
  return { type: 'pass' };
}

async function playTurn(limit = 40, earlyBreak = true) {
  let data = await api('/api/daily/start', {});
  let mine = 0;
  for (let i = 0; i < limit; i++) {
    if (data.view.status === 'over') return data;
    const p = data.pending;
    let action;
    if (p?.type === 'declareAttackers') action = { type: 'attackers', iids: p.suggested || [] };
    else if (p?.type === 'declareBlockers') action = { type: 'blockers', pairs: p.suggested || [] };
    else action = chooseAction(p);
    data = await api('/api/daily/action', { action });
    mine++;
    if (earlyBreak && data.view.status !== 'over' && data.pending?.type === 'priority' && data.view.activePlayer === 0 && data.view.step === 'main1' && mine > 6) break;
  }
  return data;
}

if (PHASE === 'phase1') {
  const data = await playTurn(12);
  const fp = fingerprint(data.view);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cookie, fp, points: data.points, url: BASE }));
  console.log('PHASE 1 — played. State saved to', STATE_FILE);
  console.log(' ', JSON.stringify(fp));
  console.log('  points:', data.points ?? 0);
} else {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  cookie = saved.cookie;
  const resumed = await api('/api/daily/start', {});
  void resumed;
  const fp = fingerprint(resumed.view);
  const same = JSON.stringify(fp) === JSON.stringify(saved.fp);
  console.log('PHASE 2 — resumed:', resumed.resumed);
  console.log('  before restart:', JSON.stringify(saved.fp));
  console.log('  after  restart:', JSON.stringify(fp));
  if (!same) {
    console.error('\nFAIL: the run did not survive the restart. On a free tier this is almost always');
    console.error('an ephemeral filesystem: set STORE_BACKEND=upstash with KV_REST_API_URL/TOKEN,');
    console.error('or attach a persistent disk / use a VPS.');
    process.exit(1);
  }
  console.log('  \u2713 identical state — the daily survived the restart');

  const done = await playTurn(500, false);
  if (done.view.status !== 'over') {
    console.log('  (still playing: turn', done.view.turn, '— run the daily to the end for the full check)');
    process.exit(0);
  }
  const name = 'DeploySmoke';
  const sub = await api('/api/submit', { name });
  const board = await api('/api/leaderboard', undefined);
  const idx = (board.entries || []).findIndex((e) => e.name === name);
  const mine = idx >= 0 ? { ...board.entries[idx], rank: idx + 1 } : null;
  console.log('  finished:', done.view.result?.reason || done.view.status, '| points:', sub.points ?? done.points ?? 0);
  console.log('  leaderboard entry:', mine ? `#${mine.rank ?? '?'} ${mine.name} ${mine.points}pts won=${mine.won}` : 'MISSING');
  if (!mine) { console.error('\nFAIL: submitted score did not reach the leaderboard.'); process.exit(1); }
  console.log('\n\u2713 deploy smoke test passed end to end');
}
