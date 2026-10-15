/**
 * "Do I still need to deploy?" — compares a running site against this checkout.
 *
 *   npm run check-live -- https://your-app.onrender.com
 *
 * Compares the three client files byte for byte, checks that the server-side
 * features exist, and reports whether the store is external (the thing that
 * decides whether a redeploy loses players' runs). Exit code 1 means the site is
 * behind this checkout, 0 means it is current — so it can gate a deploy script.
 */
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('usage: npm run check-live -- https://your-app.onrender.com');
  process.exit(2);
}

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
const get = async (path) => {
  const res = await fetch(base + path, { redirect: 'follow' });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
};

const problems = [];
console.log(`Checking ${base}\n`);

/* 1. client files — the part the browser actually renders */
for (const file of ['index.html', 'app.js', 'style.css']) {
  const local = await readFile(new URL(`../public/${file}`, import.meta.url));
  let live;
  try {
    live = await get(`/${file}`);
  } catch (e) {
    console.log(`  ${file.padEnd(11)} could not fetch (${e.message})`);
    problems.push(`${file}: unreachable`);
    continue;
  }
  const same = live.status === 200 && hash(live.buf) === hash(local);
  console.log(`  ${file.padEnd(11)} ${same ? 'up to date' : 'NEEDS DEPLOY'}  local ${local.length}B ${hash(local)} | live ${live.buf.length}B ${hash(live.buf)}`);
  if (!same) problems.push(`${file} differs`);
}

/* 2. server features — a stale server can serve new files, so check the API too */
const features = [
  ['/api/community', (r) => r.status === 200 && r.body?.ok === true && Array.isArray(r.body.decks), 'deck upload / community rotation'],
  ['/api/rules', (r) => r.status === 200, 'rules & coverage info'],
];
for (const [path, ok, label] of features) {
  let res;
  try {
    res = await fetch(base + path);
    res = { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    res = { status: 0, body: null };
  }
  const good = ok(res);
  console.log(`  ${path.padEnd(17)} ${good ? 'present' : 'MISSING'}  (${label})`);
  if (!good) problems.push(`${path} missing (${label}) — the server is an older build`);
}

/* 3. the store — an external store is what keeps runs alive across a deploy */
try {
  const health = await fetch(base + '/healthz').then((r) => r.json());
  const external = health.store === 'upstash';
  console.log(`\n  store: ${health.store} — ${external
    ? 'external, so runs, leaderboard and uploads survive a redeploy'
    : 'LOCAL FILE: a redeploy or spin-down wipes every player\'s run and the leaderboard'}`);
  console.log(`  day: ${health.day} | decks in pool: ${health.decks} | uptime: ${health.uptimeSec}s`);
  if (!external) problems.push('store is not external (set STORE_BACKEND=upstash)');
} catch (e) {
  console.log(`\n  store: could not read /healthz (${e.message})`);
  problems.push('/healthz unreachable');
}

console.log('');
if (problems.length) {
  console.log(`${problems.length} thing(s) to fix:`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\nSee DEPLOY.md §7 for the push procedure and the deploy checklist.');
  process.exit(1);
}
console.log('The live site matches this checkout.');
