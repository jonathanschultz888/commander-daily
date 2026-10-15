/**
 * Check Upstash REST credentials before you paste them into a host.
 *
 *   node scripts/check-kv.mjs https://xxx.upstash.io <token>
 *   # or, with the env vars already exported:
 *   node scripts/check-kv.mjs
 *
 * Does a real PING, then a SET/GET/DEL round trip, so it catches the two things
 * a copy-paste cannot: a truncated token, and a *read-only* token (reads work,
 * every write fails — which would silently break the daily the moment someone
 * played).
 *
 * Exits 0 when the credentials are good, 1 otherwise, and says what to fix.
 */
const url = (process.argv[2]
  || process.env.KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_URL
  || '').trim().replace(/\/+$/, '');
const token = (process.argv[3]
  || process.env.KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || '').trim();

const fail = (msg, hint) => {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

if (!url) fail('No REST URL given.', 'Usage: node scripts/check-kv.mjs https://xxx.upstash.io <token>');
if (!token) fail('No token given.', 'Pass it as the second argument, or set KV_REST_API_TOKEN.');

// The single most common mix-up: copying the TCP Redis URL instead of the REST one.
if (/^rediss?:\/\//i.test(url)) {
  fail(`That is a TCP Redis URL, not the REST URL: ${url.slice(0, 40)}…`,
    'This app talks to the Upstash REST API. Use the https://… endpoint from the REST API section.');
}
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url);
if (!/^https:\/\//i.test(url) && !isLocal) {
  fail(`The REST URL must start with https:// — got "${url.slice(0, 40)}".`,
    'Copy the "Endpoint" value from the REST API section (it looks like https://us1-xxx-12345.upstash.io).');
}
if (isLocal) console.log('  ! Local endpoint — skipping the production-URL checks.');
if (/:\d+/.test(url.replace(/^https:\/\//i, '').split('/')[0])) {
  console.warn('  ! The URL contains a port — the REST endpoint normally has none. Continuing anyway.');
}
if (token.length < 20) {
  console.warn(`  ! That token is only ${token.length} characters — Upstash tokens are ~40+. Continuing anyway.`);
}

console.log(`\nChecking ${url}\n`);

async function command(args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

/* 1 — is the endpoint + token valid at all? */
let ping;
try {
  ping = await command(['PING']);
} catch (e) {
  if (e.name === 'TimeoutError') fail('The request timed out.', 'Check your internet connection, or try again — Upstash occasionally takes a few seconds on a cold database.');
  fail(`Could not reach that URL: ${e.cause?.code || e.message}`,
    'Check for a typo in the endpoint. It looks like https://us1-merry-cat-32748.upstash.io (no trailing slash, no /set/foo/bar).');
}
if (ping.json?.result !== 'PONG') {
  const err = ping.json?.error || ping.text.slice(0, 120);
  if (/WRONGPASS|unauthor/i.test(err)) {
    fail(`The database rejected the token: ${err}`,
      'Re-copy UPSTASH_REDIS_REST_TOKEN from Connect → REST (or the REST API section).\n'
      + '    Note the Read-Only Token switch: if it is ON you may have copied the read-only token.');
  }
  if (ping.status === 404) {
    fail(`404 from that URL: ${err}`,
      'A REST URL should accept the command in the body. If you pasted a path (/set/foo/bar) or a TCP host:port, re-copy the Endpoint value.');
  }
  fail(`Unexpected response (HTTP ${ping.status}): ${err}`, 'Re-copy both values from the Upstash console.');
}
ok('endpoint reachable and the token authenticates');

/* 2 — can this token WRITE? (a read-only token passes step 1 and fails here) */
const key = `commander-daily:check:${Date.now().toString(36)}`;
const set = await command(['SET', key, 'ok']);
if (set.json?.result !== 'OK') {
  const err = set.json?.error || set.text.slice(0, 120);
  fail(`The token cannot write: ${err}`,
    'You very likely copied the Read-Only token. In the Upstash console check the "Read-Only Token" switch is OFF,\n'
    + '    then copy the plain Token again. The daily save and the leaderboard both need write access.');
}
ok('the token can write (SET succeeded)');

/* 3 — can it read back? */
const got = await command(['GET', key]);
if (got.json?.result !== 'ok') {
  fail(`Wrote the key but read back ${JSON.stringify(got.json?.result)}.`, 'That is unusual — re-copy both values and try again.');
}
ok('it can read back what it wrote (GET succeeded)');

/* 4 — clean up after ourselves. */
const del = await command(['DEL', key]);
ok(`cleaned up the test key${del.json?.result === 1 ? '' : ' (nothing to delete)'}`);

console.log(`
  All good. Paste these into your host:

    KV_REST_API_URL    ${url}
    KV_REST_API_TOKEN  <the same token you just used>

  The app also accepts Upstash's own names (UPSTASH_REDIS_REST_URL / _TOKEN),
  so you can paste them without renaming. Set STORE_BACKEND=upstash too.
`);
