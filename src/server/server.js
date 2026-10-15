/**
 * HTTP server: API + static client.
 *
 * Server-authoritative by design. The engine runs here, the client only renders
 * what it is told and sends intents back — which is what makes the daily honest:
 * there is no client-side state to rewind, and a reload resumes the same run.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAllDecks } from '../decks/index.js';
import { createGame, reviveGame, packGame } from '../engine/game.js';
import { runEngine, playOpening, applyPlayerAction as applyAction } from '../engine/driver.js';
import { makeBot } from '../engine/bot.js';
import { scoreSummary } from '../engine/score.js';
import { cardScript } from '../engine/scripts.js';
import { characteristics, isLand } from '../engine/cards.js';
import * as store from './store.js';
import * as daily from './daily.js';
import { verifyDeck, communityRecord } from './verifyDeck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const DECKS = loadAllDecks();
const DECK_BY_ID = new Map(DECKS.map((d) => [d.id, d]));

if (!process.env.SESSION_SECRET) {
  console.warn('[server] SESSION_SECRET is not set — every restart invalidates existing cookies,');
  console.warn('[server] which means players lose their in-progress daily. Set it in production.');
}

await store.load();

// Runs only matter for their own day; keep today and yesterday so a late-night
// player who reloads just after the 1am rollover still sees their result.
store.pruneRuns([daily.dayKeyFor(), daily.previousDayKey(daily.dayKeyFor())]);

/* ------------------------------------------------------------------ */
/* Session tokens: signed, stored as a cookie + readable by the client. */
/* ------------------------------------------------------------------ */

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function issueToken() {
  const raw = crypto.randomBytes(24).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64url').slice(0, 16);
  return `${raw}.${sig}`;
}
const validToken = (t) => {
  if (!t || !t.includes('.')) return false;
  const [raw, sig] = t.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(raw).digest('base64url').slice(0, 16);
  return sig === expect;
};

function sessionOf(req, res) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)cd_session=([^;]+)/);
  let token = m ? decodeURIComponent(m[1]) : null;
  if (!validToken(token)) {
    token = issueToken();
    const proto = req.headers['x-forwarded-proto'] || '';
    const secure = String(proto).includes('https') || process.env.COOKIE_SECURE === '1' ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `cd_session=${encodeURIComponent(token)}; Path=/;${secure} Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }
  const tokenHash = hash(token);
  store.touchSession(tokenHash);
  return { token, tokenHash };
}

/* ------------------------------------------------------------------ */
/* Game <-> JSON                                                       */
/* ------------------------------------------------------------------ */

function makeRun({ mode, setup, tokenHash }) {
  const [deckA, deckB] = setup.decks;
  const game = createGame({ decks: [deckA, deckB], seed: setup.seed, options: { humanIsBot: true } });
  game.bot = makeBot(deckB.prototype);
  game.mode = mode;
  game.openingTurns = setup.openingTurns;
  game.takeoverAt = (setup.openingTurns || 3) + 1;

  // Play the opening, then hand the human a turn with a real decision in it.
  playOpening(game);
  // Worth logging: this is the one moment that decides what the player will see,
  // and it is the thing most likely to differ between two installs of a day.
  console.log(`[run] ${mode} seed=${setup.seed} ${setup.humanDeck.id} vs ${setup.botDeck.id}`
    + ` | takeover turn ${game.turn} prompt=${game.pending?.actions?.length ?? 0}`
    + ` delayed=${game.openingDelayed}${game.status === 'over' ? ' (opening ended the game)' : ''}`);
  return game;
}

function runRecord({ mode, setup, tokenHash }) {
  return {
    mode, dayKey: setup.dayKey || null, seed: setup.seed,
    deckIds: setup.decks.map((d) => d.id),
    humanDeck: setup.humanDeck, botDeck: setup.botDeck,
    openingTurns: setup.openingTurns || 3,
    humanIsA: setup.decks[0].id === setup.humanDeck.id,
    tokenHash,
  };
}

/* ------------------------------------------------------------------ */
/* Views                                                              */
/* ------------------------------------------------------------------ */

function cardView(card, { hidden = false } = {}) {
  if (!card) return null;
  if (hidden) return { iid: card.iid, hidden: true };
  const script = cardScript(card);
  return {
    iid: card.iid, name: card.name, mana_cost: card.card?.mana_cost || card.manaCost || '', cmc: card.cmc,
    type_line: card.type_line, oracle_text: card.oracle_text, image: card.image,
    colors: card.colors, isCommander: !!card.isCommander, isToken: !!card.isToken,
    unsupported: script.unsupported.length ? script.unsupported.length : 0,
  };
}

function permView(game, perm) {
  const ch = characteristics(game, perm);
  return {
    iid: perm.iid, name: perm.name, mana_cost: perm.card.mana_cost || '', image: perm.card.image,
    type_line: perm.card.type_line, oracle_text: perm.card.oracle_text,
    controller: perm.controller, tapped: perm.tapped, isToken: !!perm.isToken,
    isCommander: !!perm.isCommander, damage: perm.damage, counters: perm.counters,
    power: ch.power, toughness: ch.toughness, keywords: [...ch.keywords],
    types: ch.types, subtypes: ch.subtypes, summonedThisTurn: perm.summoningSick,
    attachments: perm.attachments.map((a) => a.iid), equippedTo: perm.attachedTo?.iid || null,
    isLand: ch.types.includes('Land'),
  };
}

function viewFor(game, { sinceEvent = 0, playerCounts = {} } = {}) {
  const me = game.humanId;
  const opp = game.other(me);
  const pending = null;
  return {
    status: game.status,
    mode: game.mode,
    turn: game.turn,
    turnNumber: game.turnNumberFor?.[me] || 0,
    oppTurnNumber: game.turnNumberFor?.[opp] || 0,
    step: game.step,
    activePlayer: game.activePlayer,
    priority: game.priority,
    stack: game.stack.map((s) => ({
      iid: s.iid, kind: s.kind, name: s.card?.name || s.source?.name || 'ability',
      controller: s.controller, targets: (s.targets || []).map((t) => (typeof t === 'number' ? `player:${t}` : t?.iid)),
      oracle_text: s.card?.oracle_text || s.spec?.raw || '', type_line: s.card?.type_line || 'Ability',
    })),
    players: game.players.map((p, i) => ({
      id: p.id, name: i === me ? 'You' : p.name, isBot: p.isBot, life: p.life,
      handCount: p.zones.hand.length,
      hand: i === me ? p.zones.hand.map((c) => cardView(c)) : p.zones.hand.map(() => ({ hidden: true })),
      library: p.zones.library.length,
      graveyard: p.zones.graveyard.map((c) => cardView(c)),
      exile: p.zones.exile.map((c) => cardView(c)),
      command: p.zones.command.map((c) => cardView(c)),
      manaPool: p.manaPool, commanderDamage: p.commanderDamage || {},
      deckName: p.deck.name, bracket: p.deck.bracket,
      theme: p.deck.theme, themeName: p.deck.themeName, commander: p.deck.commander,
    })),
    battlefield: game.battlefield.map((p) => permView(game, p)),
    log: game.logLines.slice(-40),
    events: game.events.slice(sinceEvent).map((e) => ({ ...e, ctx: undefined })),
    eventCursor: game.events.length,
    points: game.scores?.[me]?.total || 0,
    pointLines: (game.scores?.[me]?.lines || []).filter((l) => l.label).slice(-14),
    oppPoints: game.scores?.[opp]?.total || 0,
    combos: game.comboHistory,
    result: game.result,
    modal: game.modal || null,
  };
}

function pendingFor(game) {
  const p = game.pending;
  if (!p) return null;
  if (p.type === 'priority') {
    return { type: 'priority', actions: p.actions.filter((a) => !a.hidden) };
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
};

const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 256 * 1024);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/**
 * Cheap in-memory rate limit. A public instance is one abuse-spam away from
 * burning a free tier's bandwidth or CPU, and the daily needs protecting from
 * scripted farming too. Per session token, per window, keyed by route class.
 */
const buckets = new Map();
// Per session AND per address: a client without a cookie is handed a new session
// on every request, so an address key is what actually stops a cookie-less flood.
// A whole-process cap sits on top of both.
const LIMITS = {
  read: { token: 300, ip: 900, ms: 60_000 },
  write: { token: 240, ip: 600, ms: 60_000 },
  import: { token: 10, ip: 30, ms: 60_000 },
};
const GLOBAL_LIMIT = { max: Number(process.env.RATE_GLOBAL_PER_MIN || 6000), ms: 60_000 };

function clientIp(req) {
  // Only trust the header when the app is knowingly behind a proxy that sets it.
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function hit(key, max, ms) {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + ms };
  if (now > b.reset) { b.count = 0; b.reset = now + ms; }
  b.count++;
  buckets.set(key, b);
  if (buckets.size > 20000) buckets.clear(); // stay bounded
  return b.count > max ? Math.ceil((b.reset - now) / 1000) : 0;
}

function rateLimited(req, tokenHash, klass) {
  const { token, ip, ms } = LIMITS[klass];
  const addr = clientIp(req);
  const waits = [
    hit(`all`, GLOBAL_LIMIT.max, GLOBAL_LIMIT.ms),
    hit(`${klass}:ip:${addr}`, ip, ms),
    tokenHash ? hit(`${klass}:t:${tokenHash}`, token, ms) : 0,
  ];
  return Math.max(...waits);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/** Run a live game forward until it needs the human or finishes. */
function advance(game, { stopForHuman = true } = {}) {
  return runEngine(game, { stopForHuman });
}

function persistRun(tokenHash, mode, dayKey, run, game) {
  store.putRun(tokenHash, dayKey, mode, { ...run, state: packGame(game) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { tokenHash } = sessionOf(req, res);
  const dayKey = daily.dayKeyFor();
  const msLeft = daily.msUntilReset();

  try {
    /* ---------------- bootstrap ---------------- */
    if (url.pathname === '/api/bootstrap') {
      const setup = daily.dailySetup(dayKey);
      const run = store.getRun(tokenHash, dayKey, 'daily');
      const voteDay = daily.nextDayKey(dayKey);
      const options = daily.voteOptions(dayKey);
      const myVote = store.getVotes(dayKey)[tokenHash]?.choice || null;
      return json(res, 200, {
        dayKey, msUntilReset: msLeft, resetHourET: daily.RESET_HOUR_ET,
        daily: {
          bracket: setup.bracket,
          humanDeck: setup.humanDeck,
          botDeck: setup.botDeck,
          openingTurns: setup.openingTurns,
          votedDeck: store.winningVote(daily.previousDayKey(dayKey)),
        },
        run: run ? {
          status: run.state?.status, finished: run.state?.status === 'over',
          submitted: !!run.submitted, points: run.points || 0, mode: run.mode,
        } : null,
        practice: {
          available: true,
          excludes: [setup.humanDeck.id, setup.botDeck.id],
        },
        vote: { dayKey: voteDay, ...options, tally: store.tallyVotes(dayKey), myVote },
        leaderboard: store.scoresForDay(dayKey, 50),
        stats: store.leaderboardStats(dayKey),
        allTime: store.allTime(25),
        decks: DECKS.map((d) => ({ id: d.id, name: d.name, bracket: d.bracket, commander: d.commander, theme: d.theme, themeName: d.themeName, blurbs: d.blurb })),
        meta: { version: '0.1.0', pack: DECKS.length, ...rulesInfo().pool },
      });
    }

    /* ---------------- daily ---------------- */
    if (url.pathname === '/api/daily/start' && req.method === 'POST') {
      let record = store.getRun(tokenHash, dayKey, 'daily');
      if (record && record.state?.status === 'over') {
        return json(res, 200, {
          resumed: true, finished: true, mode: 'daily',
          view: viewFor(reviveGame(record.state), {}), pending: null,
          submitted: !!record.submitted, points: record.points || 0,
        });
      }
      if (!record) {
        const setup = daily.dailySetup(dayKey);
        const game = makeRun({ mode: 'daily', setup, tokenHash });
        const run = { ...runRecord({ mode: 'daily', setup, tokenHash }), startedAt: new Date().toISOString(), points: 0 };
        persistRun(tokenHash, 'daily', dayKey, run, game);
        record = store.getRun(tokenHash, dayKey, 'daily');
        return json(res, 200, {
          resumed: false, mode: 'daily', view: viewFor(game, { sinceEvent: game.events.length }), pending: pendingFor(game),
          takeover: { openingTurns: setup.openingTurns, humanDeck: setup.humanDeck, botDeck: setup.botDeck, bracket: setup.bracket },
        });
      }
      const game = reviveGame(record.state);
      advance(game);
      persistRun(tokenHash, 'daily', dayKey, record, game);
      return json(res, 200, { resumed: true, mode: 'daily', view: viewFor(game, {}), pending: pendingFor(game) });
    }

    if (url.pathname === '/api/daily/action' && req.method === 'POST') {
      const body = await readBody(req);
      const record = store.getRun(tokenHash, dayKey, 'daily');
      if (!record) return json(res, 409, { error: 'No daily run. Start one first.' });
      const game = reviveGame(record.state);
      const out = applyPlayerAction(game, body.action, record);
      if (out.error) { persistRun(tokenHash, 'daily', dayKey, record, game); return json(res, 400, out); }
      advance(game);
      persistRun(tokenHash, 'daily', dayKey, record, game);
      return json(res, 200, { view: viewFor(game, { sinceEvent: Number(body.sinceEvent) || 0 }), pending: pendingFor(game), points: game.scores?.[game.humanId]?.total || 0 });
    }

    /* ---------------- practice ---------------- */
    if (url.pathname === '/api/practice/start' && req.method === 'POST') {
      const setup = daily.dailySetup(dayKey);
      const exclude = [setup.humanDeck.id, setup.botDeck.id];
      const seed = crypto.randomInt(1, 2 ** 31);
      const pSetup = daily.practiceSetup(seed, exclude);
      const game = makeRun({ mode: 'practice', setup: pSetup, tokenHash });
      game.practiceSeed = seed;
      // Practice is a throwaway run: never stored against the day, so it can be
      // replayed as often as you like.
      practiceGames.set(tokenHash, { game, setup: pSetup, exclude });
      return json(res, 200, {
        mode: 'practice', view: viewFor(game, { sinceEvent: game.events.length }), pending: pendingFor(game),
        takeover: { openingTurns: pSetup.openingTurns, humanDeck: pSetup.humanDeck, botDeck: pSetup.botDeck, bracket: pSetup.bracket },
      });
    }

    if (url.pathname === '/api/practice/action' && req.method === 'POST') {
      const body = await readBody(req);
      const sess = practiceGames.get(tokenHash);
      if (!sess) return json(res, 409, { error: 'No practice game. Start a new one.' });
      const game = sess.game;
      const out = applyPlayerAction(game, body.action, sess);
      if (out.error) return json(res, 400, out);
      advance(game);
      return json(res, 200, { view: viewFor(game, { sinceEvent: Number(body.sinceEvent) || 0 }), pending: pendingFor(game), points: game.scores?.[game.humanId]?.total || 0 });
    }

    /* ---------------- submit score ---------------- */
    if (url.pathname === '/api/submit' && req.method === 'POST') {
      const body = await readBody(req);
      const record = store.getRun(tokenHash, dayKey, 'daily');
      if (!record?.state || record.state.status !== 'over') return json(res, 400, { error: 'Finish the daily first.' });
      if (store.hasSubmitted(tokenHash, dayKey)) return json(res, 409, { error: 'You already submitted today.' });
      const name = String(body.name || '').trim().slice(0, 20) || 'Anonymous';
      const game = reviveGame(record.state);
      const summary = scoreSummary(game);
      const entry = {
        name, dayKey, tokenHash, points: summary.total, won: summary.won, turns: summary.turns,
        combos: summary.combos, reason: summary.reason,
        humanDeck: record.humanDeck?.name, botDeck: record.botDeck?.name,
        bracket: record.botDeck?.bracket,
        lines: summary.lines.slice(-8),
      };
      store.addScore(entry);
      record.submitted = true;
      record.points = summary.total;
      persistRun(tokenHash, 'daily', dayKey, record, game);
      return json(res, 200, { ok: true, entry, leaderboard: store.scoresForDay(dayKey, 50), stats: store.leaderboardStats(dayKey) });
    }

    /* ---------------- rate limiting ---------------- */
    const klass = url.pathname === '/api/import' ? 'import'
      : req.method === 'POST' && url.pathname.startsWith('/api/') ? 'write' : 'read';
    const retryAfter = rateLimited(req, tokenHash, klass);
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return json(res, 429, { error: `Rate limit reached (${klass}). Try again in ${retryAfter}s.` });
    }

    /* ---------------- ops ---------------- */
    // Cheap liveness/readiness check (no session, no game state) — what a
    // free tier's uptime pinger should hit to keep the instance warm.
    if (url.pathname === '/healthz') {
      const st = store.stats();
      return json(res, 200, {
        ok: true, day: daily.dayKeyFor(),
        decks: DECKS.length, store: st.backend, dirty: st.dirty,
        lastSavedAt: st.lastSavedAt, error: st.lastError || null,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    // Store internals. Guarded when ADMIN_TOKEN is set, since it counts players.
    if (url.pathname === '/api/store-stats') {
      if (process.env.ADMIN_TOKEN && url.searchParams.get('token') !== process.env.ADMIN_TOKEN) {
        return json(res, 403, { error: 'Forbidden' });
      }
      return json(res, 200, store.stats());
    }

    /* ---------------- deck import (paste a list) ---------------- */
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      // Verification is the gate for the shared rotation. A deck either plays
      // completely for every player, or it is not in the pool — with the exact
      // blocking cards reported back, plus automatic substitutions that fix it.
      const result = verifyDeck(String(body.text || ''), {
        name: body.name,
        bracket: body.bracket,
        repair: body.repair !== false,
      });
      let added = null;
      if (result.ok && body.addToPool !== false) {
        const record = communityRecord(result.deck, result.report, { addedBy: `session-${tokenHash.slice(0, 8)}` });
        // The id is a fingerprint of the list, so re-submitting the same cards
        // refreshes that one slot instead of adding a twin to the pool.
        const existing = store.getCommunityDeck(record.id);
        if (existing && existing.addedAt) record.addedAt = existing.addedAt; // keep its place in the day being played out
        store.putCommunityDeck(record);
        // Tell the uploader exactly when this deck can be played against other
        // people: practice immediately, the shared daily from the next reset
        // (the pool is frozen at 01:00 ET so a day cannot change underfoot).
        added = {
          id: record.id, name: record.name, bracket: record.bracket, commander: record.commander,
          alreadyInRotation: !!existing,
          addedAt: record.addedAt,
          playableNow: 'practice',
          entersDailyAt: daily.dayStartMs(daily.nextDayKey(daily.dayKeyFor())) > Date.now()
            ? new Date(daily.dayStartMs(daily.nextDayKey(daily.dayKeyFor()))).toISOString()
            : null,
          entersDailyOn: daily.nextDayKey(daily.dayKeyFor()),
        };
        console.log(`[community] + ${record.name} (${record.commander}, B${record.bracket}) verified ${record.coverage.automated}/${record.coverage.total}`);
      }
      return json(res, result.ok ? 200 : 422, { ok: result.ok, added, report: result.report });
    }

    // Moderation. Deck names and the lists themselves are shown publicly, so a
    // bad upload has to be removable — and only by the operator: the endpoint
    // refuses to work at all unless ADMIN_TOKEN is configured.
    if (url.pathname === '/api/community/remove' && req.method === 'POST') {
      const admin = process.env.ADMIN_TOKEN;
      if (!admin) return json(res, 403, { error: 'Moderation is disabled: set ADMIN_TOKEN to enable it.' });
      const body = await readBody(req);
      if (body.token !== admin) return json(res, 403, { error: 'Forbidden' });
      const id = String(body.id || '');
      const existing = store.getCommunityDeck(id);
      if (!existing) return json(res, 404, { error: 'No such deck' });
      store.removeCommunityDeck(id);
      console.log(`[community] − ${existing.name} removed by the operator`);
      return json(res, 200, { ok: true, removed: id });
    }

    if (url.pathname === '/api/community' && req.method === 'GET') {
      const decks = store.communityDecks()
        .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
        .map((d) => ({
          id: d.id, name: d.name, commander: d.commander, bracket: d.bracket,
          theme: d.theme, addedAt: d.addedAt, addedBy: d.addedBy,
          coverage: d.coverage, verified: !!d.verified,
        }));
      return json(res, 200, { ok: true, decks, count: decks.length });
    }

    /* ---------------- vote ---------------- */
    if (url.pathname === '/api/vote' && req.method === 'POST') {
      const body = await readBody(req);
      const options = daily.voteOptions(dayKey);
      const choice = String(body.choice || '');
      const valid = choice === 'random' || options.options.some((o) => o.id === choice);
      if (!valid) return json(res, 400, { error: 'Unknown deck choice.' });
      store.castVote(dayKey, tokenHash, choice);
      const tally = store.tallyVotes(dayKey);
      return json(res, 200, { ok: true, myVote: choice, tally, leading: store.winningVote(dayKey) });
    }

    /* ---------------- leaderboard ---------------- */
    if (url.pathname === '/api/leaderboard') {
      const which = url.searchParams.get('day') || dayKey;
      return json(res, 200, {
        dayKey: which, entries: store.scoresForDay(which, 100),
        stats: store.leaderboardStats(which), allTime: store.allTime(25),
      });
    }

    /* ---------------- deck & rules info ---------------- */
    if (url.pathname === '/api/decks') {
      return json(res, 200, {
        decks: DECKS.map((d) => ({
          id: d.id, name: d.name, bracket: d.bracket, commander: d.commander, theme: d.theme,
          themeName: d.themeName, blurb: d.blurb, prototype: d.prototype, total: d.total,
          uniqueCards: d.uniqueCards,
          gameChangers: d.profile.gameChangers, combos: d.profile.combos.map((c) => c.name),
        })),
      });
    }
    if (url.pathname === '/api/rules') {
      return json(res, 200, rulesInfo());
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(req, res);
  } catch (err) {
    console.error('[server]', err);
    const status = Number(err?.status) || 500;
    return json(res, status, { error: status === 413 ? 'Request too large' : 'server error', detail: String(err.message || err) });
  }
});

/* ------------------------------------------------------------------ */
/* Applying a player action                                            */
/* ------------------------------------------------------------------ */

function applyPlayerAction(game, action, sess) {
  if (!action || typeof action !== 'object') return { error: 'missing action' };
  if (game.status === 'over') return { error: 'game is over' };
  // One implementation, shared with every other way a seat can be driven
  // (see src/engine/driver.js) — a player over HTTP is not a special case.
  return applyAction(game, game.humanId, action);
}

/* ------------------------------------------------------------------ */
/* Rules/coverage info surfaced to the client                          */
/* ------------------------------------------------------------------ */

function rulesInfo() {
  let scripted = 0; let compiled = 0; let partial = 0;
  const unsupportedPhrases = new Map();
  for (const deck of DECKS) {
    for (const card of deck.cardList) {
      const s = cardScript(card);
      if (s.unsupported.length) {
        partial++;
        for (const u of s.unsupported) unsupportedPhrases.set(u, (unsupportedPhrases.get(u) || 0) + 1);
      } else if (s.onEnter || s.triggers.length || s.abilities.length || s.steps || s.statics.length || s.mana.length) scripted++;
      else compiled++;
    }
  }
  return {
    engine: {
      implemented: [
        'Turn structure CR 500-514 (untap, upkeep, draw, main, combat, end, cleanup)',
        'Priority and the stack CR 117/405',
        'State-based actions CR 704 (lethal damage, 0 toughness, life <= 0, legend rule, auras, counters annihilate)',
        'Layer system CR 613 for P/T and ability-adding effects',
        'Combat CR 506-511 (attackers, blockers, first/double strike, trample, deathtouch, lifelink, infect)',
        'Commander rules CR 903 (colour identity, command zone, tax, 21 commander damage)',
        'Mana: automatic land/rock tapping, duals, any-colour sources, cost reducers',
        'Replacement-lite: token doublers, damage modifiers, enters-tapped lands',
      ],
      notImplemented: [
        'Full CR 614/616 replacement-effect ordering and self-replacement layers',
        'Full CR 613 dependency loops between continuous effects',
        'Copy effects beyond permanent copies (no spell copying stack objects)',
        'Alternate/additional costs beyond commander tax (kicker, flashback, escape, delve as printed costs)',
        'APNAP choice ordering for simultaneous multi-player choices',
        'Combat damage assignment by the attacker among multiple blockers (auto-assigned)',
      ],
    },
    pool: { decks: DECKS.length, uniqueCards: new Set(DECKS.flatMap((d) => d.cardList.map((c) => c.name))).size, scripted, compiled, partial },
    unsupportedSample: [...unsupportedPhrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

const practiceGames = new Map();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — flushing store…`);
  try { await store.saveNow(); } catch (e) { console.warn('[server] flush failed:', e.message); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Commander Daily listening on http://0.0.0.0:${PORT}`);
  console.log(`  day key: ${daily.dayKeyFor()}  | resets in ${Math.round(daily.msUntilReset() / 60000)} min`);
  console.log(`  ${DECKS.length} decks loaded`);
  console.log(`  store: ${store.stats().backend}`);
});

export { server };
