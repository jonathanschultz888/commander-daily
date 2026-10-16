/* ==========================================================================
   Commander Daily — client
   The server owns the game. This file renders state, collects intents, and
   plays the animations. No framework, no external requests.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  sacrificePick: null,
  boot: null, mode: 'daily', view: null, pending: null,
  selected: null, targeting: null, attackers: new Set(), blocks: [], blockPick: null,
  lastCursor: 0, takeoverShown: false, clockTimer: null, dragging: null, busy: false,
};

/* ---------------- api ---------------- */
async function api(path, body, method = 'POST') {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Rejections carry a full verification report; attach it to the error so the
    // caller can render the reasons instead of a bare message.
    const err = new Error(json.error || json.report?.fatal || `request failed (${res.status})`);
    err.status = res.status;
    err.report = json.report;
    throw err;
  }
  return json;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- theming (driven by the opponent deck) ---------------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
/**
 * The site wears the opponent's deck: its colour *and* its commander's artwork.
 * The art is the actual illustration from the card (Scryfall's art crop, derived
 * from the same image URL), so the table changes every day with the challenge.
 */
function applyTheme(hex, { art = null, portrait = null } = {}) {
  const root = document.documentElement.style;
  if (hex) {
    const { r, g, b } = hexToRgb(hex);
    root.setProperty('--accent', hex);
    root.setProperty('--accent-soft', `rgba(${r},${g},${b},0.16)`);
    root.setProperty('--accent-glow', `rgba(${r},${g},${b},0.45)`);
  }
  if (art) {
    root.setProperty('--table-art', `url("${art}")`);
    document.body.classList.add('has-art');
  }
  if (portrait) {
    root.setProperty('--deck-portrait', `url("${portrait}")`);
    const slot = document.querySelector('#oppAvatarArt');
    if (slot) slot.style.backgroundImage = `url("${portrait}")`;
  }
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', '#0b0f14');
}

/** Show a deck's commander art in the tab icons / avatars. */
function paintArt(node, url) {
  if (!node) return;
  if (url) node.style.backgroundImage = `url("${url}")`;
}

/* ---------------- countdown to 01:00 ET ---------------- */
function startClock(msUntilReset) {
  let target = Date.now() + (msUntilReset || 0);
  const tick = () => {
    const left = Math.max(0, target - Date.now());
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000), s = Math.floor((left % 60000) / 1000);
    const text = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    for (const node of $$('#resetClock, #sidebarClock')) node.textContent = text;
    if (left <= 0) { clearInterval(S.clockTimer); location.reload(); }
  };
  clearInterval(S.clockTimer);
  tick();
  S.clockTimer = setInterval(tick, 1000);
}

/* ==========================================================================
   LOBBY
   ========================================================================== */
async function boot() {
  S.boot = await api('/api/bootstrap', undefined, 'GET');
  document.body.classList.remove('loading');
  applyTheme(S.boot.daily.botDeck.theme, { art: S.boot.daily.botDeck.art, portrait: S.boot.daily.botDeck.portrait });
  for (const tab of $$('.tab')) {
    const art = S.boot.daily.botDeck.portrait;
    const slot = tab.querySelector('.tab-icon');
    if (slot && art) slot.style.backgroundImage = `url("${art}")`;
  }
  paintArt($('#dailyArtYou'), S.boot.daily.humanDeck.portrait);
  paintArt($('#dailyArtBot'), S.boot.daily.botDeck.portrait);
  $('#dayKey').textContent = S.boot.dayKey;
  $('#brandSub').textContent = `Bracket ${S.boot.daily.bracket} · ${S.boot.daily.botDeck.themeName}`;
  startClock(S.boot.msUntilReset);
  renderLobby();
  renderCommunity().catch(() => {});   // the Tools tab shows it; harmless if it fails
  showPane('daily');
  const run = S.boot.run;
  if (run && !run.finished) {
    $('#btnStartDaily').hidden = true;
    $('#btnResumeDaily').hidden = false;
    $('#btnResumeDaily').textContent = `Resume today's run (${run.points || 0} pts)`;
  }
  if (run && run.finished) {
    $('#btnStartDaily').textContent = 'Review today\'s finished run';
    $('#dailyFineprint').textContent = run.submitted
      ? 'Score submitted. Come back after 1am ET for a fresh puzzle.'
      : 'Run finished — submit your name to appear on the leaderboard.';
  }
}

function renderLobby() {
  const d = S.boot.daily;
  const you = d.humanDeck, bot = d.botDeck;
  $('#heroTitle').innerHTML = `${esc(you.name)} <span class="muted">vs</span> ${esc(bot.name)}`;
  $('#heroSub').innerHTML = `The bot plays the opening ${d.openingTurns} of your turns for you — identically for every player — then hands you the board. `
    + `You pilot <strong>${esc(you.commander)}</strong> against <strong>${esc(bot.commander)}</strong>`
    + (d.votedDeck ? ` — a deck the community voted in.` : '.');
  const artStyle = (u) => (u ? ` style="background-image:url('${u}')"` : '');
  $('#matchup').innerHTML = `
    <div class="duelist">
      <div class="duelist-art" id="dailyArtYou"${artStyle(you.art)}><span class="art-tag">you pilot</span></div>
      <div class="duelist-body">
        <div class="name">${esc(you.name)}</div>
        <div class="cmdr">${esc(you.commander)}</div>
        <div class="pill-row"><span class="pill">Bracket ${you.bracket}</span></div>
      </div>
    </div>
    <div class="vs">VS</div>
    <div class="duelist bot">
      <div class="duelist-art" id="dailyArtBot"${artStyle(bot.art)}><span class="art-tag">bot · themes the site</span></div>
      <div class="duelist-body">
        <div class="name">${esc(bot.name)}</div>
        <div class="cmdr">${esc(bot.commander)}</div>
        <div class="pill-row"><span class="pill accent">Bracket ${bot.bracket}</span><span class="pill">${esc(bot.themeName)}</span></div>
      </div>
    </div>`;
  $('#dailyFineprint').textContent = `One scored attempt, resets at 1:00 am ET. Practice is unlimited and never counts.`;

  // deck list
  $('#deckCards').innerHTML = S.boot.decks.map((dk) => `
    <div class="deck-mini">
      <div class="deck-art" style="background-image:url('${dk.portrait || ''}'); border-color:${dk.theme}"></div>
      <div><strong>${esc(dk.name)}</strong><br><span class="muted small">${esc(dk.commander)}</span></div>
      <span class="b" style="color:${dk.theme}">B${dk.bracket}</span>
    </div>`).join('');

  renderLeaderboardInto($('#lobbyLeaderboard'), S.boot.leaderboard, S.boot.stats);
  renderStats();
  renderVote();
}

function renderStats() {
  const pool = S.boot.meta;
  const box = $('#engineStats');
  box.innerHTML = `
    <div class="row"><span>Decks in pool</span><span>${pool.pack}</span></div>
    <div class="row"><span>Brackets 1–5 covered</span><span>yes</span></div>
    <div class="row"><span>Game Changers list</span><span>live from Scryfall</span></div>
    <div class="row"><span>Rules core</span><span>stack · layers · SBAs</span></div>
    <div class="row"><span>Reset</span><span>01:00 ET</span></div>
    <button class="ghost tiny" id="btnCoverage">Card coverage report</button>`;
  $('#btnCoverage').onclick = showCoverage;
  const info = $('#buildInfo');
  if (info) {
    const total = (pool.uniqueCards || 0);
    const auto = (pool.scripted || 0) + (pool.compiled || 0) + (pool.partial || 0);
    info.textContent = `v${pool.version} · ${pool.pack} decks · ${auto}/${total} cards fully or partly automated${pool.partial ? ` (${pool.partial} partial)` : ''} · resets 01:00 ET`;
  }
}

async function showCoverage() {
  const info = await api('/api/rules', undefined, 'GET');
  openModal(`
    <h1>Engine coverage</h1>
    <p class="muted small">The simulator implements the parts of the Comprehensive Rules that decide games of Commander. Cards are automated by hand-written scripts first, then by a text compiler — anything a card does that neither can express is listed below rather than silently ignored.</p>
    <div class="pill-row">
      <span class="pill accent">${info.pool.uniqueCards} unique cards</span>
      <span class="pill">${info.pool.scripted} scripted</span>
      <span class="pill">${info.pool.compiled} auto-playable</span>
      <span class="pill">${info.pool.partial} partially automated</span>
    </div>
    <h3>Implemented</h3>
    <ul class="howto">${info.engine.implemented.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h3>Deliberately not implemented</h3>
    <ul class="howto">${info.engine.notImplemented.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h3>Most common unparsed oracle phrases</h3>
    <ul class="howto">${info.unsupportedSample.map(([p, n]) => `<li>${esc(p)} <span class="muted">×${n}</span></li>`).join('') || '<li class="muted">None — everything parsed.</li>'}</ul>
  `);
}

/* ---------------- vote ---------------- */
function renderVote() {
  const v = S.boot.vote;
  const box = $('#voteOptions');
  const total = Object.values(v.tally.counts || {}).reduce((a, b) => a + b, 0) || 0;
  box.innerHTML = v.options.map((o) => {
    const count = (v.tally.counts || {})[o.id] || 0;
    const pct = total ? Math.round((count / total) * 100) : 0;
    return `<button class="vote-opt ${v.myVote === o.id ? 'chosen' : ''}" data-id="${o.id}">
      <span class="deck-swatch" style="background:${o.theme}"></span>
      <span><strong>${esc(o.name)}</strong><br><span class="muted small">${esc(o.commander)} · B${o.bracket}</span></span>
      <span class="tally">${count} · ${pct}%</span></button>`;
  }).join('') + `<button class="vote-opt ${v.myVote === 'random' ? 'chosen' : ''}" data-id="random">
      <span class="deck-swatch" style="background:linear-gradient(90deg,#e63946,#f1faee,#457b9d)"></span>
      <span><strong>Surprise me</strong><br><span class="muted small">Let the seeded pick decide</span></span>
      <span class="tally">${(v.tally.counts || {}).random || 0}</span></button>`;
  $$('.vote-opt', box).forEach((b) => b.onclick = async () => {
    const r = await api('/api/vote', { choice: b.dataset.id });
    S.boot.vote.myVote = r.myVote; S.boot.vote.tally = r.tally;
    renderVote();
    toast(r.leading ? `Vote counted — ${r.leading} leads for tomorrow.` : 'Vote counted. Ties fall back to the seeded pick.');
  });
}

/* ---------------- leaderboard ---------------- */
function renderLeaderboardInto(node, entries, stats) {
  if (!entries || !entries.length) { node.innerHTML = '<p class="muted">No scores yet today — be the first.</p>'; return; }
  node.innerHTML = `<table><tbody>${entries.slice(0, 12).map((e, i) => `
    <tr><td>${i + 1}. ${esc(e.name)}</td><td>${e.won ? '🏆' : ''} ${e.points}</td></tr>`).join('')}</tbody></table>
    ${stats ? `<p class="muted small" style="margin-top:.5rem">${stats.total} runs · ${stats.winRate}% win rate · avg ${stats.avg} pts · best ${stats.best}</p>` : ''}`;
}

async function showLeaderboard() {
  const day = S.boot.dayKey;
  const data = await api(`/api/leaderboard?day=${day}`, undefined, 'GET');
  openModal(`
    <h1>Leaderboard · ${esc(day)}</h1>
    <p class="muted small">Points come from how the run went: turns used, interaction that mattered, permanents protected, and combos assembled.</p>
    <table class="score-table">
      <thead><tr><th>#</th><th>Player</th><th>Deck</th><th class="num">Turns</th><th class="num">Pts</th></tr></thead>
      <tbody>${data.entries.map((e, i) => `<tr>
        <td>${i + 1}</td><td>${esc(e.name)} ${e.won ? '🏆' : ''}</td>
        <td class="muted small">${esc(e.humanDeck || '')}</td>
        <td class="num">${e.turns}</td><td class="num">${e.points}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">Nobody has finished today yet.</td></tr>'}</tbody>
    </table>
    <h3>All-time</h3>
    <table class="score-table"><thead><tr><th>Player</th><th class="num">Runs</th><th class="num">Wins</th><th class="num">Points</th></tr></thead>
      <tbody>${data.allTime.map((e) => `<tr><td>${esc(e.name)}</td><td class="num">${e.runs}</td><td class="num">${e.wins}</td><td class="num">${e.points}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No submissions yet.</td></tr>'}</tbody>
    </table>`);
}

/* ==========================================================================
   STARTING RUNS
   ========================================================================== */
async function startDaily() {
  const data = await api('/api/daily/start', {});
  S.mode = 'daily';
  if (data.finished) { S.view = data.view; S.pending = null; renderGame(); return; }
  enterGame(data, 'daily');
}

async function startPractice() {
  const data = await api('/api/practice/start', {});
  S.mode = 'practice';
  enterGame(data, 'practice');
  toast('Practice round — excludes today\'s two decks. Unlimited retries.');
}

function enterGame(data, mode) {
  S.view = data.view; S.pending = data.pending; S.mode = mode;
  S.lastCursor = 0; S.takeoverShown = false; S.gameOverShown = false; S.attackers.clear(); S.blocks = [];
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  document.body.classList.add('game-active');
  // The site adopts the *opponent's* deck colours (daily) or the practice opponent's.
  applyTheme(S.view.players[1]?.theme || S.boot.daily.botDeck.theme, {
    art: S.view.players[1]?.art || S.boot.daily.botDeck.art,
    portrait: S.view.players[1]?.portrait || S.boot.daily.botDeck.portrait,
  });
  renderGame();
  if (data.takeover && mode === 'practice') showTakeover(data.takeover, true);
  else if (data.takeover) showTakeover(data.takeover, false);
}

/* ==========================================================================
   GAME RENDER
   ========================================================================== */
function renderGame() {
  const v = S.view;
  if (!v) return;
  const me = v.players[0], opp = v.players[1];

  $('#oppName').textContent = opp.name;
  $('#oppDeckName').textContent = `${opp.deckName} · B${opp.bracket}`;
  $('#oppLife').textContent = opp.life;
  $('#myLife').textContent = me.life;
  $('#myDeckName').textContent = `${me.deckName} · B${me.bracket}`;
  $('#metaTurn').textContent = v.turn;
  $('#metaPhase').textContent = `${v.activePlayer === 0 ? 'Your' : 'Their'} ${v.step}`;
  $('#metaOppPts').textContent = v.oppPoints;
  $('#pointsMode').textContent = S.mode === 'daily' ? 'Daily' : 'Practice';
  const strip = $('#stripMode');
  if (strip) strip.textContent = S.mode === 'daily' ? 'Daily · scored' : 'Practice · no stakes';

  renderHand(me);
  renderOpponentHand(opp);
  renderBattlefield(opp, 'opp');
  renderBattlefield(me, 'my');
  renderPiles(opp, 'opp');
  renderPiles(me, 'my');
  renderMana(me);
  renderStack();
  renderPoints();
  renderLog();
  renderCombos();
  renderActions();
  renderPromptBar();
  playNewEvents();
  if (v.status === 'over') showGameOver();
}

function cardEl(card, { inHand = false, controller = 0, legalTarget = false } = {}) {
  const n = el('div', `card card-inspect${card.isCommander ? ' commander' : ''}${card.isToken ? ' token' : ''}`);
  n.dataset.iid = card.iid;
  if (card.hidden) {
    n.classList.add('hidden-card');
    n.innerHTML = '<div class="name">Face-down card</div>';
    return n;
  }
  if (card.image) n.style.setProperty('--img', `url(${card.image})`);
  const art = card.image ? `<div class="art" style="background-image:url('${card.image}')"></div>` : '';
  const pt = card.power != null && card.toughness != null && !card.isLand ? `<div class="pt">${card.power}/${card.toughness}</div>` : '';
  n.innerHTML = `${art}
    <div class="name">${esc(card.name)}</div>
    <div class="card-mid">
      <div class="type">${esc(card.type_line || '')}</div>
      <div class="cost">${esc(card.mana_cost || '')}</div>
    </div>
    <div class="text">${esc(trimOracle(card.oracle_text))}</div>
    ${pt}`;
  if (card.counters && (card.counters['+1/+1'] || card.counters['-1/-1'] || card.counters.slumber || card.counters.charge)) {
    const c = card.counters;
    if (c['+1/+1']) n.appendChild(el('div', 'counter-pip', `+${c['+1/+1']}`));
    if (c['-1/-1']) n.appendChild(el('div', 'counter-pip minus', `-${c['-1/-1']}`));
    if (c.slumber) n.appendChild(el('div', 'counter-pip', `☾${c.slumber}`));
    if (c.charge) n.appendChild(el('div', 'counter-pip', `⚡${c.charge}`));
  }
  if (card.damage > 0) n.appendChild(el('div', 'dmg-pip', `${card.damage}`));
  if (card.attachments && card.attachments.length) n.appendChild(el('div', 'attach-pip', `⚔${card.attachments.length}`));
  if (card.unsupported) n.appendChild(el('div', 'unsupported-dot', '≈'));
  if (card.tapped) n.classList.add('tapped');
  if (legalTarget) n.classList.add('legal-target');
  return n;
}

/**
 * Card text as it appears on the card: reminder text in brackets is dropped (it
 * is the first thing to cut on a 118px card) and the rest keeps its line breaks,
 * because "Enchant creature" followed by the effect is how the card reads.
 */
function trimOracle(text) {
  if (!text) return '';
  const lines = String(text).split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^\(.*\)$/.test(l))
    .map((l) => l.replace(/\s*\([^)]*\)\s*$/, ''));
  return lines.filter(Boolean).join('\n').slice(0, 300);
}

/**
 * Every legal thing this specific card can do right now, in the words a player
 * would use. The list is built from the engine's own legal actions, so it can
 * never offer something the server would reject.
 */
/**
 * The artwork of a card, given the "normal" print URL the engine hands the client.
 * Scryfall serves every crop of the same print from the same path, so swapping the
 * size segment turns a full card face into the picture window. This is what the
 * sheet header, menu buttons and deck chrome are painted with: the game's own
 * imagery rather than a generic icon set.
 */
function artOf(image) {
  if (!image) return null;
  return String(image).replace(/\/(normal|large|small|png)\//, '/art_crop/');
}

function optionsFor(iid) {
  const acts = S.pending?.type === 'priority' ? (S.pending.actions || []) : [];
  return acts.filter((a) => a.iid === iid).map((a) => {
    const mana = a.mana || '';
    if (a.type === 'playLand') return { action: a, icon: '🃏', label: `Play ${a.name}`, hint: 'Your land for this turn.' };
    if (a.type === 'cast') return { action: a, icon: '✨', label: `Cast ${a.name}`, hint: mana ? `Costs ${mana}.` : 'No mana cost.' };
    const label = String(a.label || '').includes(' — ') ? String(a.label).split(' — ').slice(1).join(' — ') : (a.label || 'Activate');
    const bits = [a.name];
    if (a.legalSacrifices?.length) bits.push('needs a creature to sacrifice');
    if (a.targetSpec && (a.legalTargets || []).length) bits.push('needs a target');
    return { action: a, icon: '⚙', label, hint: `${bits.join(' · ')}.` };
  });
}

/** The "what can this do" sheet: one row per legal option, never a single click commit. */
function openCardMenu(card, node) {
  const opts = optionsFor(card.iid);
  const mine = node ? node.classList.contains('mine-zone') : true;
  const rows = opts.map((o, i) => `
    <button class="opt" data-opt="${i}">
      <span class="opt-icon">${o.icon}</span>
      <span class="opt-body"><strong>${esc(o.label)}</strong><span class="muted small">${esc(o.hint)}</span></span>
    </button>`).join('');
  const art = artOf(card.image);
  openModal(`
    <div class="opt-head" ${art ? `style="--opt-art:url('${art}')"` : ''}>
      <div class="opt-portrait" ${card.image ? `style="background-image:url('${card.image}')"` : ''}></div>
      <div>
        <h1>${esc(card.name)}</h1>
        <p class="muted small">${esc(card.type_line || '')}${card.mana_cost ? ` · <span class="opt-mana">${esc(card.mana_cost)}</span>` : ''}</p>
      </div>
    </div>
    ${opts.length ? `<div class="opt-list">${rows}</div>` : `<p class="muted">Nothing legal to do with this card right now${mine ? '' : ' — it is not yours'}. You can still read it below.</p>`}
    <div class="opt-read">${esc(trimOracle(card.oracle_text) || 'No rules text.')}</div>
    <div class="opt-tools">
      <button class="ghost" id="optReport">⚑ Report a problem with this card</button>
    </div>`);
  $$('#modalBody .opt').forEach((btn) => {
    btn.onclick = () => {
      const o = opts[Number(btn.dataset.opt)];
      closeModal();
      chooseAction(o.action);
    };
  });
  const rep = $('#optReport');
  if (rep) rep.onclick = () => { closeModal(); inspect(card); };
}

function renderHand(me) {
  const wrap = $('#myHand');
  wrap.innerHTML = '';
  const count = $('#handCount');
  if (count) count.textContent = `${me.hand.length} card${me.hand.length === 1 ? '' : 's'}`;
  const playable = new Map();
  for (const a of (S.pending?.type === 'priority' ? S.pending.actions : [])) {
    if (a.type === 'playLand' || a.type === 'cast' || a.type === 'activate') {
      if (!playable.has(a.iid)) playable.set(a.iid, a);
    }
  }
  const n = me.hand.length;
  // A big hand would otherwise run off the edge of the table: overlap more as the
  // hand grows (never so much that the name and rules text disappear).
  // Shallower as long as the hand fits, deeper only when it must be: a card keeps
  // ~94px of visible width (the title line plus a sliver of the rules text) before
  // the fan starts hiding anything the player needs.
  const overlap = n <= 8 ? 14 : Math.round(14 + Math.min(40, (n - 8) * 6));
  // the card width is the stylesheet's business (it shrinks on small screens), so
  // read it back rather than guessing: no fan may hide more than the card allows
  const cardW = parseFloat(getComputedStyle(wrap).getPropertyValue('--card-w')) || 100;
  wrap.style.setProperty('--fan-overlap', `-${Math.min(overlap, cardW - 44)}px`);
  me.hand.forEach((c, i) => {
    const node = cardEl(c, { inHand: true });
    // the fan: an arc, centred on the middle card, cards overlapping like a hand
    const mid = (n - 1) / 2;
    const off = i - mid;
    node.style.setProperty('--fan-rot', `${(off * Math.min(3.2, 16 / Math.max(n, 1))).toFixed(2)}deg`);
    node.style.setProperty('--fan-y', `${(Math.abs(off) ** 1.3 * Math.min(4, 26 / Math.max(n, 1))).toFixed(1)}px`);
    node.style.setProperty('--fan-i', String(i));
    node.style.zIndex = String(10 + i);
    const act = playable.get(c.iid);
    if (act) {
      node.classList.add('playable');
      node.draggable = false;
    }
    node.dataset.playable = act ? '1' : '';
    node.addEventListener('pointerdown', (ev) => onHandPointerDown(ev, node, c, act));
    wrap.appendChild(node);
  });
  if (!me.hand.length) wrap.appendChild(el('div', 'muted small', 'Empty hand — topdeck mode.'));
  // A hand wider than the screen (phone) scrolls sideways; centre it so the cut
  // falls evenly on the two outer cards and the fan reads as continuing off-screen
  // rather than as a hand that lost its right side.
  if (wrap.scrollWidth > wrap.clientWidth + 2) {
    wrap.scrollLeft = Math.round((wrap.scrollWidth - wrap.clientWidth) / 2);
  }
}

function renderOpponentHand(opp) {
  const wrap = $('#oppHandRow');
  wrap.innerHTML = `<span class="muted small">${opp.handCount} cards in hand</span>`;
}

function renderBattlefield(p, which) {
  // Three rows per player, so it is obvious what is what: creatures nearest the
  // middle (the "front line", facing the opponent's creatures across the combat
  // line), then other permanents — artifacts, enchantments, planeswalkers — and
  // lands at the back. Both players keep the same order from their own point of
  // view, which is how a real table is laid out.
  const zones = which === 'opp'
    ? { creatures: $('#oppZoneCreatures'), other: $('#oppZoneOther'), lands: $('#oppZoneLands') }
    : { creatures: $('#myZoneCreatures'), other: $('#myZoneOther'), lands: $('#myZoneLands') };
  for (const z of Object.values(zones)) {
    const cards = z.querySelector('.zone-cards');
    cards.innerHTML = '';
    z.classList.toggle('empty', true);
  }
  const perms = S.view.battlefield.filter((x) => x.controller === p.id);
  const bucket = (c) => (c.isLand ? 'lands' : (c.types || []).includes('Creature') ? 'creatures' : 'other');
  const place = (c) => {
    const zone = zones[bucket(c)];
    zone.classList.remove('empty');
    const n = cardEl(c, { controller: p.id, legalTarget: S.targeting?.targets?.has(c.iid) });
    if (S.attackers.has(c.iid)) n.classList.add('attacker-mark');
    if (S.blocks.some((b) => b.blocker === c.iid)) n.classList.add('blocker-mark');
    if (S.blockPick === c.iid) n.classList.add('selected');
    if (S.pending?.type === 'declareAttackers' && p.id === 0 && S.pending.legal.includes(c.iid)) {
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => {
        if (S.attackers.has(c.iid)) S.attackers.delete(c.iid); else S.attackers.add(c.iid);
        renderGame();
      });
    } else if (S.pending?.type === 'declareBlockers' && p.id === 0) {
      n.addEventListener('click', () => onBlockerTap(c.iid));
    } else if (S.targeting) {
      n.addEventListener('click', () => onTargetPick(c.iid));
    }
    if (which === 'my' && S.pending?.type === 'priority') {
      const acts = S.pending.actions.filter((a) => a.type === 'activate' && a.iid === c.iid);
      if (acts.length) {
        n.style.cursor = 'pointer';
        n.classList.add('playable');
        // Several legal abilities ("Remove a charge counter: choose one") means the
        // sheet, so the mode is chosen deliberately rather than guessed.
        n.addEventListener('click', () => (acts.length > 1 ? openCardMenu(c, n) : chooseAction(acts[0])));
      }
    }
    // a permanent in your sacrifice window lights up like a target
    if (S.sacrificePick && S.sacrificePick.legal.has(c.iid)) {
      n.classList.add('legal-sacrifice', 'legal-target');
      n.addEventListener('click', () => onSacrificePick(c.iid));
    }
    n.title = c.oracle_text || '';
    n.addEventListener('dblclick', () => inspect(c));
    zone.querySelector('.zone-cards').appendChild(n);
  };
  // creatures first (front), then the rest, then lands — order within a zone stays stable
  for (const c of perms) place(c);
}

function renderPiles(p, which) {
  const wrap = which === 'opp' ? $('#oppPiles') : $('#myPiles');
  wrap.innerHTML = `
    <span class="pile" data-pile="library">📚 ${p.library}</span>
    <span class="pile" data-pile="graveyard">⚰ ${p.graveyard.length}</span>
    <span class="pile" data-pile="exile">✦ ${p.exile.length}</span>
    ${p.command.length ? `<span class="pile" data-pile="command">👑 ${p.command.length}</span>` : ''}
    ${Object.entries(p.commanderDamage || {}).length ? `<span class="pile">☠ ${Object.entries(p.commanderDamage).map(([k, v]) => `${k.split(',')[0]} ${v}`).join(' · ')}</span>` : ''}`;
  $$('.pile', wrap).forEach((n) => n.onclick = () => showPile(p, n.dataset.pile, which));
}

function showPile(p, pile, which) {
  const cards = pile === 'library' ? [] : (p[pile] || []);
  openModal(`<h1>${pile} · ${esc(p.name)}</h1>
    ${pile === 'library' ? `<p class="muted">${p.library} cards left. Contents are hidden.</p>` : ''}
    <div class="zone-row">${cards.map((c) => {
      const holder = cardEl(c);
      return holder.outerHTML;
    }).join('') || '<p class="muted">Empty.</p>'}</div>`);
}

function renderMana(me) {
  const wrap = $('#manaRow');
  // Nothing floats and nothing to say: stay quiet. (It used to print a paragraph of
  // mana rules under the board every single turn.)
  wrap.innerHTML = me.manaPool.length
    ? `<span class="muted small">Mana pool:</span> ${me.manaPool.map((c) => `<span class="mana-pip">${c}</span>`).join('')}`
    : '';
  wrap.hidden = !me.manaPool.length;
}

function renderStack() {
  const zone = $('#stackZone');
  zone.innerHTML = '';
  S.view.stack.forEach((s) => {
    const n = el('div', 'stack-item', `<strong>${esc(s.name)}</strong> <span class="muted">${esc(s.type_line)}</span> <span class="muted small">(${s.controller === 0 ? 'you' : 'opponent'})</span>`);
    zone.appendChild(n);
  });
}

function renderPoints() {
  const v = S.view;
  const total = v.points || 0;
  $('#pointsTotal').textContent = total;
  const max = Math.max(30, total, v.oppPoints || 0);
  $('#pointsBarFill').style.width = `${Math.min(100, (total / max) * 100)}%`;
  $('#pointsList').innerHTML = (v.pointLines || []).slice(-12).map((l) => `
    <li class="${l.points < 0 ? 'neg' : ''}"><span>${esc(l.label)}</span><span class="pts">${l.points > 0 ? '+' : ''}${l.points}</span></li>`).join('');
}

/**
 * The log is a record of beats, not a transcript. Land drops are announced as a
 * toast when they happen (the board already shows the land), and lines the engine
 * marks `quiet` never make it into the feed at all.
 */
function renderLog() {
  const lines = (S.view.log || [])
    .filter((l) => !l.quiet)
    .slice(-22);
  $('#logFeed').innerHTML = lines.map((l) => `<div class="e ${l.kind === 'points' ? 'pts' : ''}"><span class="muted">T${l.turn}</span> ${esc(l.text)}</div>`).join('');
}

function renderCombos() {
  const feed = $('#comboFeed');
  const combos = (S.view.combos || []).filter((c) => c.player === 0);
  const oppCombos = (S.view.combos || []).filter((c) => c.player === 1);
  // Empty means empty: the "no combos yet" line is the stylesheet's :empty::after,
  // so writing our own placeholder here printed it twice.
  feed.innerHTML = [
    ...combos.map((c) => `<div class="combo-item">You: ${esc(c.name)} <span class="muted">T${c.turn}</span></div>`),
    ...oppCombos.map((c) => `<div class="combo-item" style="opacity:.7">Opponent: ${esc(c.name)} <span class="muted">T${c.turn}</span></div>`),
  ].join('');
}

/**
 * The sidebar's action list is now only a summary; everything a player can
 * *press* lives in the dock in the middle of the table (see renderPromptBar), so
 * a decision is never something you have to scroll to find.
 */
function renderActions() {
  const box = $('#actionChips');
  if (!box) return;
  const p = S.pending;
  box.innerHTML = '';
  if (!p) return;
  const acts = p.type === 'priority' ? (p.actions || []).filter((a) => a.type !== 'pass') : [];
  const hint = p.type === 'priority'
    ? (acts.length ? `${acts.length} play${acts.length === 1 ? '' : 's'} available in the dock.` : 'Nothing to play — pass priority to continue.')
    : 'Follow the prompt in the middle of the table.';
  box.appendChild(el('p', 'muted small', hint));
}

/**
 * The dock: one place, in the middle of the table, that always shows what you
 * can do right now. Priority offers become buttons here (they used to live in
 * the sidebar, which on a phone is a sheet you have to open), the combat prompts
 * keep their confirm buttons, and target selection announces itself in the same
 * spot so the eye never has to hunt for the next step.
 */
function renderPromptBar() {
  const bar = $('#promptBar');
  const p = S.pending;
  if (!p && !S.targeting && !S.sacrificePick) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;

  if (S.sacrificePick) {
    const n = S.sacrificePick.legal.size;
    bar.innerHTML = `<span class="dock-title">🩸 Sacrifice</span>
      <span class="grow">${esc(S.sacrificePick.action.sacrificeLabel || 'Choose a creature to sacrifice')} — ${n} of yours can pay this cost. Tap it on your side of the table.</span>
      <button class="ghost tiny" id="cancelSacrifice">Cancel</button>`;
    $('#cancelSacrifice').onclick = () => { S.sacrificePick = null; renderGame(); };
    return;
  }
  if (S.targeting) {
    const spec = S.targeting.action.targetSpec || {};
    bar.innerHTML = `<span class="dock-title">🎯 Pick a target</span>
      <span class="grow">Choose what <strong>${esc(S.targeting.action.name)}</strong> points at${describeSpec(spec)}.</span>
      <button class="ghost tiny" id="cancelTarget">Cancel</button>`;
    $('#cancelTarget').onclick = () => { S.targeting = null; renderGame(); };
    return;
  }
  if (p.type === 'declareAttackers') {
    bar.innerHTML = `<span class="dock-title">⚔ Attack</span>
      <span class="grow">Tap your creatures to send them, then confirm. Opponent at ${p.defenderLife} life.</span>
      <button class="primary" id="confirmAttack">${S.attackers.size ? `Attack with ${S.attackers.size}` : 'No attackers'}</button>
      <button class="ghost tiny" id="clearAttack"${S.attackers.size ? '' : ' hidden'}>Clear</button>`;
    $('#confirmAttack').onclick = () => send({ type: 'attackers', iids: [...S.attackers] });
    $('#clearAttack').onclick = () => { S.attackers.clear(); renderGame(); };
    return;
  }
  if (p.type === 'declareBlockers') {
    bar.innerHTML = `<span class="dock-title">🛡 Block</span>
      <span class="grow">Tap one of your creatures, then the attacker it blocks. ${S.blocks.length ? `${S.blocks.length} assigned.` : 'No blocks assigned.'}</span>
      <button class="primary" id="confirmBlocks">${S.blocks.length ? 'Confirm blocks' : 'Take it'}</button>
      <button class="ghost tiny" id="clearBlocks"${S.blocks.length ? '' : ' hidden'}>Clear</button>`;
    $('#confirmBlocks').onclick = () => send({ type: 'blockers', pairs: S.blocks });
    $('#clearBlocks').onclick = () => { S.blocks = []; renderGame(); };
    return;
  }
  if (p.type === 'priority') {
    const acts = (p.actions || []).filter((a) => a.type !== 'pass');
    const chips = acts.map((a, i) => `<button class="dock-chip" data-act="${i}">
        <span class="mana">${esc(a.mana || '')}</span><span class="dock-chip-label" title="${esc(a.label)}">${esc(a.label)}</span>
        ${(a.x || a.needsX) ? '<span class="tag">X</span>' : ''}${a.legalSacrifices?.length ? '<span class="tag sac">sacrifice</span>' : ''}${a.targetSpec ? '<span class="tag target">target</span>' : ''}
      </button>`).join('');
    bar.innerHTML = `<span class="dock-title">${S.view?.activePlayer === S.view?.humanId ? 'Your move' : 'Respond'}</span>
      <div class="dock-actions">${chips || '<span class="muted small">Nothing left to play</span>'}</div>
      <button class="primary dock-pass" id="dockPass">Pass priority ▸</button>`;
    acts.forEach((a, i) => { const b = bar.querySelector(`[data-act="${i}"]`); if (b) b.onclick = () => chooseAction(a); });
    const pass = $('#dockPass');
    if (pass) pass.onclick = () => sendPass();
    return;
  }
  // an unknown prompt type: say so rather than showing an empty dock
  bar.innerHTML = `<span class="grow">Waiting for the table…</span>`;
}

/** A short, plain-language hint about what counts as a legal target. */
function describeSpec(spec) {
  const f = spec.filter || {};
  const bits = [];
  if (spec.kind === 'spell') bits.push(f.creature ? 'a creature spell' : f.noncreature ? 'a noncreature spell' : 'a spell on the stack');
  else if (spec.kind === 'player') bits.push('a player');
  else {
    if (f.land) bits.push('a land');
    else if (f.artifactOrEnchantment) bits.push('an artifact or enchantment');
    else if (f.artifact) bits.push('an artifact');
    else if (f.enchantment) bits.push('an enchantment');
    else if (f.creature) bits.push('a creature');
    else if (f.nonland) bits.push('a nonland permanent');
    else bits.push('a permanent');
    if (f.controller === 'you') bits.push('you control');
    if (f.controller === 'opp') bits.push('an opponent controls');
    if (f.attacking) bits.push('that is attacking');
  }
  return bits.length ? ` — ${bits.join(' ')}` : '';
}

function inspect(card) {
  openModal(`<h1>${esc(card.name)}</h1>
    <div class="pill-row"><span class="pill accent">${esc(card.mana_cost || '')}</span><span class="pill">${esc(card.type_line || '')}</span>
    ${card.isCommander ? '<span class="pill accent">Commander</span>' : ''}${card.isToken ? '<span class="pill">Token</span>' : ''}</div>
    <p style="white-space:pre-wrap">${esc(card.oracle_text || 'No rules text.')}</p>
    ${card.power != null ? `<p class="muted">Power/toughness: ${card.power}/${card.toughness}</p>` : ''}
    <div class="report-row"><button class="ghost tiny" id="btnReportCard">⚑ This card misbehaved</button>
    <span class="muted small">Tell us what you saw — the engine checks the card and fixes what it can.</span></div>`);
  const btn = $('#btnReportCard');
  if (btn) btn.onclick = () => reportCard(card);
}

/**
 * The player-facing report. It is answered by the server's own analysis of the
 * card (printed text vs. compiled script), not by a queue: when the gap is one
 * the engine can close mechanically, the fix is saved and used from then on, and
 * the player is told exactly that.
 */
function reportCard(card, note = '') {
  openModal(`<h1>Report ${esc(card.name)}</h1>
    <p class="muted">What did it do? Being specific helps: the phase, what you expected, what happened instead.</p>
    <textarea id="reportNote" rows="3" maxlength="500" placeholder="It went onto the battlefield without asking what it should enchant…">${esc(note)}</textarea>
    <div class="name-row">
      <button class="primary" id="reportSend">Send report</button>
      <button class="ghost" id="reportCancel">Cancel</button>
    </div>
    <div id="reportResult"></div>`);
  $('#reportCancel').onclick = () => inspect(card);
  $('#reportSend').onclick = async () => {
    const text = ($('#reportNote').value || '').trim();
    const box = $('#reportResult');
    box.innerHTML = '<p class="muted small">Checking the card against the engine…</p>';
    try {
      const out = await api('/api/report-card', { name: card.name, note: text });
      box.innerHTML = reportVerdictHtml(out);
      const close = $('#reportClose');
      if (close) close.onclick = () => closeModal();
      toast(out.corrected ? 'Correction saved — thanks!' : 'Report received.');
    } catch (e) {
      box.innerHTML = `<p class="bad">${esc(e.message)}</p>`;
    }
  };
}

function reportVerdictHtml(out) {
  const mark = (f) => (f.bad ? '<span class="mark bad">✖</span>' : f.warn ? '<span class="mark warn">⚠</span>' : '<span class="mark ok">✔</span>');
  return `<div class="report-verdict ${out.corrected ? 'good' : ''}">
      <p><strong>${esc(out.verdict)}</strong></p>
      <ul class="check-list">${(out.findings || []).map((f) => `<li class="${f.bad ? 'bad' : f.warn ? 'warn' : 'ok'}">${mark(f)}<span>${esc(f.text)}</span></li>`).join('')}</ul>
    </div>
    <div class="name-row"><button class="ghost" id="reportClose">Close</button></div>`;
}

/* ==========================================================================
   INTERACTION — select, drag, target, act
   ========================================================================== */
function onHandPointerDown(ev, node, card, action) {
  // Even an empty-handed tap gives the player the card's own sheet first: options
  // if it has any, the full text and the report button if it does not. Committing
  // on a single tap made every play feel like a trap. Dragging is still the fast
  // path for anyone who wants it.
  if (!action) { openCardMenu(card, node); return; }
  const start = { x: ev.clientX, y: ev.clientY };
  let ghost = null;
  let moved = false;
  S.selected = card.iid;
  $$('.card.selected').forEach((n) => n.classList.remove('selected'));
  node.classList.add('selected');

  const move = (e) => {
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) > 8) {
      moved = true;
      ghost = node.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${node.offsetWidth}px`;
      document.body.appendChild(ghost);
      node.classList.add('dragging');
      $$('.board, .hand-panel').forEach((r) => r.classList.add('drop-lane'));
    }
    if (ghost) {
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      $$('.board, .hand-panel').forEach((r) => {
        const box = r.getBoundingClientRect();
        const over = e.clientX > box.left && e.clientX < box.right && e.clientY > box.top - 30 && e.clientY < box.bottom + 30;
        r.classList.toggle('hover', over);
      });
    }
  };
  const up = (e) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (ghost) ghost.remove();
    node.classList.remove('dragging');
    $$('.board, .hand-panel').forEach((r) => r.classList.remove('hover'));
    if (moved) {
      const lanes = $$('.board').map((r) => ({ r, box: r.getBoundingClientRect() }));
      const hit = lanes.find(({ box }) => e.clientX > box.left && e.clientX < box.right && e.clientY > box.top - 30 && e.clientY < box.bottom + 30);
      if (hit && (hit.r.dataset.lane === 'my' || !hit.r.dataset.lane)) { chooseAction(action); return; }
      if (hit) { toast('That is your opponent\'s side of the table.'); return; }
      return;
    }
    // A tap always opens the sheet — even for a card with exactly one legal play,
    // because "tap = that play happens" is the one-click commit players asked us
    // to remove. Dragging a card onto the table is the deliberate fast path.
    openCardMenu(card, node);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function chooseAction(action) {
  // A cost of "sacrifice a creature" is a real choice (CR 601.2h) — ask which one
  // before anything else, because it is part of paying, not part of the effect.
  if (action.legalSacrifices && action.legalSacrifices.length) {
    startSacrificePick(action);
    return;
  }
  if (action.targetSpec && (action.legalTargets || []).length) {
    startTargeting(action);
    return;
  }
  if (action.needsX) {
    const max = action.maxX || 3;
    const x = Math.max(1, Math.min(max, Math.floor(max / 2) || 1));
    sendAction({ ...toSend(action), x });
    toast(`Cast with X=${x}. (Chosen automatically — full mana control is a planned feature.)`);
    return;
  }
  sendAction(toSend(action));
}

function toSend(a) {
  if (a.type === 'playLand') return { type: 'playLand', iid: a.iid };
  if (a.type === 'cast') return { type: 'cast', iid: a.iid };
  const out = { type: 'activate', iid: a.iid, index: a.index };
  if (a.sacrifice) out.sacrifice = a.sacrifice;
  if (a.needsX) out.x = a.x;
  return out;
}

/**
 * "Choose a creature to sacrifice": the cards you may feed to the cost light up
 * on your own board, exactly like targeting, because that is what it is.
 */
function startSacrificePick(action) {
  S.sacrificePick = { action, legal: new Set(action.legalSacrifices || []) };
  renderGame();
  toast(action.sacrificeLabel || 'Choose a creature to sacrifice — tap one of yours.', 3400);
}

function onSacrificePick(iid) {
  const pick = S.sacrificePick;
  if (!pick) return;
  if (!pick.legal.has(iid)) { toast('That one cannot be sacrificed to this ability.'); return; }
  S.sacrificePick = null;
  const action = { ...pick.action, sacrifice: iid };
  // now the rest of the cost/effect: a target if it needs one, otherwise commit
  if (action.targetSpec && (action.legalTargets || []).length) { startTargeting(action); return; }
  renderGame();
  sendAction({ ...toSend(action), sacrifice: iid });
}

function startTargeting(action) {
  S.targeting = { action, targets: new Set(action.legalTargets || []), players: new Set() };
  // player targets are returned as numbers
  S.targeting.targets.forEach((t) => { if (typeof t === 'number') { S.targeting.players.add(t); S.targeting.targets.delete(t); } });
  renderGame();
  toast('Choose a target — tap a glowing card or the opponent\'s life total.', 3200);
  // clicking a life total targets a player
  $('#oppLife').style.cursor = S.targeting.players.size ? 'crosshair' : '';
  $('#oppLife').onclick = () => { if (S.targeting?.players.size) onTargetPick(1); };
  $('#myLife').onclick = () => { if (S.targeting?.players.size) onTargetPick(0); };
}

function onTargetPick(iid) {
  if (!S.targeting) return;
  const t = S.targeting;
  const ref = typeof iid === 'number' ? `player:${iid}` : iid;
  if (typeof iid === 'number' && !t.players.has(iid)) return;
  S.targeting = null;
  $('#oppLife').onclick = null; $('#myLife').onclick = null;
  const payload = { ...toSend(t.action), targets: [ref] };
  if (t.action.sacrifice) payload.sacrifice = t.action.sacrifice;
  sendAction(payload);
}

function onBlockerTap(iid) {
  const p = S.pending;
  if (!p || p.type !== 'declareBlockers') return;
  const isBlocker = (p.blockers || []).includes(iid);
  if (isBlocker) { S.blockPick = S.blockPick === iid ? null : iid; renderGame(); return; }
  // tapped an attacker
  if (!S.blockPick) { toast('Tap one of your creatures first, then the attacker it blocks.'); return; }
  const legal = (p.legal && p.legal[S.blockPick]) || [];
  if (!legal.includes(iid)) { toast('That blocker cannot legally block this attacker (flying, protection, or already blocking).'); return; }
  S.blocks = S.blocks.filter((b) => b.blocker !== S.blockPick);
  S.blocks.push({ blocker: S.blockPick, attacker: iid });
  S.blockPick = null;
  renderGame();
}

/* ==========================================================================
   SENDING ACTIONS
   ========================================================================== */
async function sendAction(action) {
  if (S.busy) return;
  S.busy = true;
  try {
    const path = S.mode === 'daily' ? '/api/daily/action' : '/api/practice/action';
    const data = await api(path, { action, sinceEvent: S.view?.eventCursor || 0 });
    applyUpdate(data);
  } catch (e) {
    toast(e.message || 'That did not work.');
  } finally { S.busy = false; }
}
const send = sendAction;
const sendPass = () => sendAction({ type: 'pass' });

function applyUpdate(data) {
  const prevTurn = S.view?.turn;
  S.view = data.view;
  S.pending = data.pending;
  S.attackers.clear(); S.blocks = []; S.blockPick = null; S.targeting = null;
  renderGame();
  if (prevTurn !== undefined && data.view.turn !== prevTurn) {
    const b = $('#turnBanner');
    b.textContent = data.view.activePlayer === 0 ? `Your turn ${data.view.turnNumber}` : `Opponent's turn`;
    b.hidden = false;
    setTimeout(() => { b.hidden = true; }, 1600);
  }
  if (S.view.status === 'over') showGameOver();
}

/* ---------------- animations driven by engine events ---------------- */
function playNewEvents() {
  const v = S.view;
  S.lastCursor = v.eventCursor;
  for (const e of (v.events || [])) {
    switch (e.type) {
      case 'landPlayed': {
        // One line, one toast: "You play Forest". This is the whole log entry for a
        // land drop — no matching "enters the battlefield" message.
        const mine = e.controller === (v.humanId ?? 0);
        const land = (v.battlefield.find((p) => p.iid === e.card) || {}).name || 'a land';
        const who = v.players.find((p) => p.id === e.controller)?.name || 'Opponent';
        toast(`${mine ? 'You play' : `${who} plays`} ${land}`, 2200);
        fxCard(e.card, 'played-in', 700);
        break;
      }
      case 'etb': fxCard(e.card, 'played-in', 700); break;
      case 'damage': fxCard(e.target, 'hitmark', 520); break;
      case 'lifechange':
        if (e.player === 0) fxLife('#myLife'); else fxLife('#oppLife');
        break;
      case 'combo': fxCombo(e.cards || [], e.name); break;
      case 'points': fxFloat(v.points || 0, e.points, e.label, e.player); break;
      case 'spellCast': fxCard(e.card, 'hitmark', 300); break;
      case 'dies': fxCard(e.card, 'died', 620); break;
      default: break;
    }
  }
}
function fxCard(iid, cls, ms) {
  if (!iid) return;
  const n = document.querySelector(`[data-iid="${iid}"]`);
  if (!n) return;
  n.classList.add(cls);
  setTimeout(() => n.classList.remove(cls), ms);
}
function fxLife(sel) {
  const n = $(sel); if (!n) return;
  n.classList.remove('hit'); void n.offsetWidth; n.classList.add('hit');
}
function fxFloat(total, points, label, player) {
  if (player !== 0 || !points) return;
  const layer = $('#fx');
  const box = $('#pointsTotal').getBoundingClientRect();
  const boxWrap = document.querySelector('.board-wrap').getBoundingClientRect();
  const n = el('div', 'float-pts', `${points > 0 ? '+' : ''}${points} ${esc(label || '')}`);
  n.style.left = `${box.left - boxWrap.left}px`;
  n.style.top = `${Math.max(20, box.top - boxWrap.top)}px`;
  layer.appendChild(n);
  setTimeout(() => n.remove(), 1600);
  const t = $('#pointsTotal');
  t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
}
function fxCombo(iids, name) {
  const layer = $('#fx');
  const flash = el('div', 'combo-flash');
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 900);
  for (const iid of iids) {
    const n = document.querySelector(`[data-iid="${iid}"]`);
    if (!n) continue;
    n.classList.add('combo-live');
    const badge = el('div', 'combo-badge', 'Combo!');
    n.appendChild(badge);
    const b = n.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const s = el('div', 'spark');
      s.style.left = `${b.left + b.width / 2 + (Math.random() * 40 - 20)}px`;
      s.style.top = `${b.top + b.height / 2 + (Math.random() * 30 - 15)}px`;
      s.style.setProperty('--dx', `${Math.random() * 90 - 45}px`);
      s.style.setProperty('--dy', `${-40 - Math.random() * 60}px`);
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 820);
    }
    setTimeout(() => { badge.remove(); n.classList.remove('combo-live'); }, 3000);
  }
  toast(`💥 ${name}`, 3200);
}

/* ==========================================================================
   MODALS
   ========================================================================== */
/**
 * Ask the player to confirm, in the page rather than with window.confirm().
 * Native dialogs are blocked in sandboxed iframes (including the preview this
 * site is often embedded in), where confirm() silently returns false and the
 * button would appear to do nothing.
 */
function askConfirm({ title, body, ok = 'Confirm', cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    openModal(`
      <h1>${esc(title)}</h1>
      <p>${esc(body)}</p>
      <div class="name-row">
        <button class="primary" id="askOk">${esc(ok)}</button>
        <button class="ghost" id="askCancel">${esc(cancel)}</button>
      </div>`);
    const done = (answer) => { closeModal(); resolve(answer); };
    $('#askOk').onclick = () => done(true);
    $('#askCancel').onclick = () => done(false);
    const backdrop = $('#modalBackdrop');
    const once = (e) => { if (e.target === backdrop) { backdrop.removeEventListener('click', once); done(false); } };
    backdrop.addEventListener('click', once);
  });
}

function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modalBackdrop').hidden = false;
  document.body.classList.add('no-scroll');
}
function closeModal() {
  $('#modalBackdrop').hidden = true;
  $('#modalBody').innerHTML = '';
  document.body.classList.remove('no-scroll');
}

function showTakeover(t, isPractice) {
  if (S.takeoverShown) return;
  S.takeoverShown = true;
  const v = S.view;
  const opening = (v.log || []).filter((l) => l.turn <= (v.turn || 0)).slice(-40);
  openModal(`
    <h1>You're up.</h1>
    <p class="muted">The bot played the opening ${t.openingTurns} turns of both decks — the same sequence for every player today. You take over <strong>${esc(t.humanDeck.name)}</strong> (${esc(t.humanDeck.commander)}) against the bot's <strong>${esc(t.botDeck.name)}</strong>.</p>
    <div class="pill-row">
      <span class="pill accent">Turn ${v.turn} · your turn ${v.turnNumber}</span>
      <span class="pill">Bracket ${t.bracket}</span>
      <span class="pill">Your life ${v.players[0].life}</span>
      <span class="pill">Their life ${v.players[1].life}</span>
      <span class="pill">Your hand ${v.players[0].hand.length}</span>
    </div>
    <h3>What happened so far</h3>
    <div class="recap">${opening.map((l) => `<div class="line"><b>T${l.turn}</b> ${esc(l.text)}</div>`).join('') || '<div class="line muted">Nothing yet — you are first to act.</div>'}</div>
    <p class="muted small" style="margin-top:.8rem">${isPractice ? 'Practice round — nothing here touches the leaderboard.' : 'One scored attempt. Your run is saved server-side: reloading resumes it, it does not reroll it.'}</p>
    <button class="primary big" id="takeOver">Take the board</button>`);
  $('#takeOver').onclick = () => {
    closeModal();
    if (!isPractice) toast('Drag a card from your hand onto the table, or tap it to see what it can do.', 4200);
  };
}

function showGameOver() {
  if (S.gameOverShown) return;
  S.gameOverShown = true;
  const v = S.view;
  const won = v.result?.humanWon;
  const lines = v.pointLines || [];
  openModal(`
    <div class="big-result ${won ? 'win' : 'loss'}">${won ? 'Victory' : 'Defeat'}</div>
    <p class="muted">${esc(v.result?.info?.reason || '')} — turn ${v.turn}, your turn ${v.turnNumber}.
      ${won ? `You closed it out against ${esc(v.players[1].deckName)}.` : `${esc(v.players[1].deckName)} got there first.`}</p>
    <div class="pill-row">
      <span class="pill accent">${v.points} points</span>
      <span class="pill">${v.players[1].life} opponent life left</span>
      <span class="pill">${(v.combos || []).filter((c) => c.player === 0).length} combos</span>
    </div>
    <table class="score-table">
      <thead><tr><th>Award</th><th class="num">Pts</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${l.points > 0 ? '+' : ''}${l.points}</td></tr>`).join('')}</tbody>
    </table>
    ${S.mode === 'daily' && S.boot.run?.submitted ? '<p class="muted small">You already submitted today. Come back after 1am ET for a new puzzle.</p>' : S.mode === 'daily' ? `
      <h3>Put your name on the board</h3>
      <div class="name-row">
        <input id="playerName" maxlength="20" placeholder="Your name" autocomplete="off" />
        <button class="primary" id="submitScore">Submit score</button>
      </div>
      <p class="muted small" id="submitNote">You can only submit once for today's puzzle.</p>`
    : `<p class="muted small">Practice rounds are not scored. <button class="ghost tiny" id="againPractice">New practice round</button></p>`}
    <div class="end-actions">
      <button class="ghost" id="viewBoard">Look at the final board</button>
      <button class="ghost tiny" id="reportFromGame">⚑ A card misbehaved</button>
    </div>
    <p class="muted small">Tap any card on the table to read it — or to report it. Reports are checked against the printed text and fixed where the engine can.</p>`);
  const nameInput = $('#playerName');
  if (nameInput) {
    nameInput.value = localStorage.getItem('cd_name') || '';
    nameInput.focus();
  }
  $('#viewBoard').onclick = closeModal;
  const reportBtn = $('#reportFromGame');
  if (reportBtn) reportBtn.onclick = () => closeModal();   // then tap the card itself
  if ($('#submitScore')) $('#submitScore').onclick = submitScore;
  if ($('#againPractice')) $('#againPractice').onclick = () => { closeModal(); S.gameOverShown = false; startPractice(); };
}

async function submitScore() {
  const name = ($('#playerName').value || '').trim() || 'Anonymous';
  try {
    const r = await api('/api/submit', { name });
    localStorage.setItem('cd_name', name);
    rankModal(r, name);
  } catch (e) {
    $('#submitNote').textContent = e.message;
    $('#submitNote').classList.add('loss');
  }
}

function rankModal(r, name) {
  const entries = r.leaderboard || [];
  const idx = entries.findIndex((e) => e.name === name && e.points === r.entry.points);
  openModal(`
    <h1>Score submitted</h1>
    <p class="muted">${esc(name)} — ${r.entry.points} points, ${r.entry.won ? 'won' : 'lost'} on turn ${r.entry.turns}.</p>
    ${idx >= 0 ? `<p class="pill-row"><span class="pill accent">Rank #${idx + 1} today</span><span class="pill">${r.stats.total} runs in</span><span class="pill">${r.stats.winRate}% win rate today</span></p>` : ''}
    <table class="score-table"><thead><tr><th>#</th><th>Player</th><th class="num">Pts</th></tr></thead>
      <tbody>${entries.slice(0, 10).map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.name)} ${e.won ? '🏆' : ''}</td><td class="num">${e.points}</td></tr>`).join('')}</tbody></table>
    <h3>Vote for tomorrow's deck while you're here</h3>
    <div id="modalVote" class="vote-options"></div>
    <div style="margin-top:1rem"><button class="ghost" id="backLobby">Back to lobby</button></div>`);
  const box = $('#modalVote');
  const v = S.boot.vote;
  const total = Object.values(v.tally.counts || {}).reduce((a, b) => a + b, 0) || 0;
  box.innerHTML = v.options.map((o) => `<button class="vote-opt ${v.myVote === o.id ? 'chosen' : ''}" data-id="${o.id}">
      <span class="deck-swatch" style="background:${o.theme}"></span>
      <span><strong>${esc(o.name)}</strong><br><span class="muted small">${esc(o.commander)}</span></span>
      <span class="tally">${(v.tally.counts || {})[o.id] || 0}${total ? ` · ${Math.round(((v.tally.counts || {})[o.id] || 0) / total * 100)}%` : ''}</span></button>`).join('')
    + `<button class="vote-opt ${v.myVote === 'random' ? 'chosen' : ''}" data-id="random"><span class="deck-swatch" style="background:linear-gradient(90deg,#e63946,#f1faee,#457b9d)"></span><span><strong>Surprise me</strong></span></button>`;
  $$('.vote-opt', box).forEach((b) => b.onclick = async () => {
    const res = await api('/api/vote', { choice: b.dataset.id });
    S.boot.vote.myVote = res.myVote; S.boot.vote.tally = res.tally;
    toast('Vote counted for tomorrow.');
    rankModal({ ...r, leaderboard: entries }, name);
  });
  $('#backLobby').onclick = () => { closeModal(); location.reload(); };
}

/* ==========================================================================
   WIRE UP
   ========================================================================== */
function wire() {
  $('#btnStartDaily').onclick = () => startDaily().catch((e) => toast(e.message));
  $('#btnResumeDaily').onclick = () => startDaily().catch((e) => toast(e.message));
  $('#btnStartPractice').onclick = () => startPractice().catch((e) => toast(e.message));
  $('#btnInfo').onclick = () => showCoverage().catch((e) => toast(e.message));
  // (passing is the dock's business now — see renderPromptBar)
  $('#btnConcede').onclick = async () => {
    const sure = await askConfirm({
      title: 'Concede this run?',
      body: 'The result is recorded as a loss and you cannot restart today\'s attempt.',
      ok: 'Concede', cancel: 'Keep playing',
    });
    if (sure) sendAction({ type: 'concede' }).catch(() => toast('Could not concede — keep playing, or close the tab.'));
  };
  $('#modalClose').onclick = closeModal;
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === $('#modalBackdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if ($('#modalBackdrop').hidden === false) closeModal(); else if (S.targeting) { S.targeting = null; renderGame(); } }
    if (e.key === ' ' && S.pending?.type === 'priority') { e.preventDefault(); sendPass(); }
  });
  // ---------- lobby tabs: Daily / Practice / Tools ----------
  $$('.tab').forEach((t) => t.onclick = () => showPane(t.dataset.pane));
  $('#btnLeaderboard').onclick = () => showLeaderboard().catch((e) => toast(e.message));

  const backToLobby = async () => {
    // Leave the board and go back to the lobby, keeping the run intact on the
    // server: reloading the page resumes it exactly where it was.
    if (S.view && S.view.status === 'playing') {
      const leave = await askConfirm({
        title: 'Leave the board?',
        body: 'Your run is saved exactly where it is — you can resume it from the lobby.',
        ok: 'Back to the lobby', cancel: 'Keep playing',
      });
      if (!leave) return;
    }
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    document.body.classList.remove('game-active', 'no-scroll');
    showPane(S.mode === 'practice' ? 'practice' : 'daily');
    if (S.mode === 'daily') boot().catch(() => {});
  };
  $('#btnBackToLobby').onclick = backToLobby;
  // the same action, reachable from inside the game (the topbar is hidden there)
  $('#gameLobbyBtn').onclick = backToLobby;

  // ---------- tools: upload a deck ----------
  $('#btnImport').onclick = () => submitImport().catch((e) => toast(e.message));
  $('#btnImportExample').onclick = () => {
    $('#importText').value = EXAMPLE_LIST;
    $('#importName').value = $('#importName').value || 'Example Teysa list';
    toast('Example list loaded — press Verify to see the checks run.');
  };
  $('#importFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#importText').value = await file.text();
    $('#importName').value = $('#importName').value || file.name.replace(/\.[a-z0-9]+$/i, '');
  };

  // (The rail used to be a swipe-up bottom sheet on phones. It is a always-visible
  // strip under the table now, so there is no sheet to open and no gesture to learn.)
}

/* ==========================================================================
   LOBBY PANES AND TOOLS
   ========================================================================== */

function showPane(name) {
  const panes = { daily: $('#paneDaily'), practice: $('#panePractice'), tools: $('#paneTools') };
  if (!panes[name]) name = 'daily';
  for (const [key, node] of Object.entries(panes)) node.hidden = key !== name;
  $$('.tab').forEach((t) => {
    const on = t.dataset.pane === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  // The board is a full-screen view; picking a lobby tab means leaving it.
  if (name !== S.mode || !S.view) {
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    document.body.classList.remove('game-active', 'no-scroll');
  }
  if (name === 'tools') renderCommunity().catch(() => {});
}

const EXAMPLE_LIST = `1 Teysa Karlov

// creatures
1 Elenda, the Dusk Rose
1 Cruel Celebrant
1 Zulaport Cutthroat
1 Blood Artist
1 Solemn Simulacrum
1 Butcher of Malakir
1 Requiem Angel
1 Pawn of Ulamog
1 Gray Merchant of Asphodel

// other spells
1 Sifter of Skulls
1 Condemn
1 Anguished Unmaking
1 Generous Gift
1 Fellwar Stone

// lands
1 Godless Shrine
1 Isolated Chapel
1 Command Tower
1 Bojuka Bog
1 Nykthos, Shrine to Nyx

24 Swamp
24 Plains`;

/** Show the verification report exactly as the server wrote it. */
function renderImportReport(report, added, httpStatus) {
  const box = $('#importResult');
  box.hidden = false;
  const rows = report.checks.map((c) => `
    <li class="${c.ok ? 'ok' : 'bad'}">
      <span class="mark">${c.ok ? '✓' : '✗'}</span>
      <span><strong>${esc(c.label)}</strong>${c.detail ? `<br><span class="muted small">${esc(c.detail)}</span>` : ''}</span>
    </li>`).join('');
  const swaps = (report.substitutions || []).length ? `
    <h3>Swapped in automatically</h3>
    <ul class="swap-list">${report.substitutions.map((s) => `
      <li><span class="out">${esc(s.out)}</span> → <span class="in">${esc(s.in)}</span>
      <br><span class="muted small">${esc(s.reason)}</span></li>`).join('')}</ul>` : '';
  const blockers = (report.blockers || []).length ? `
    <h3>Cards the engine cannot play completely yet</h3>
    <ul class="swap-list">${report.blockers.map((b) => `
      <li><strong>${esc(b.name)}</strong> <span class="pill">${esc(b.status)}</span>
      <br><span class="muted small">${esc((b.unsupported || [])[0] || '')}</span></li>`).join('')}</ul>` : '';
  // Say plainly when the new deck can be played, because the daily pool is
  // frozen at the 1am ET reset: you can test it in practice right now, and it
  // joins the shared puzzle tomorrow rather than changing today's.
  const when = added
    ? (added.entersDailyOn
      ? ` Practice can play it right now; it ${added.alreadyInRotation ? 'is in' : 'joins'} the daily rotation from <strong>${esc(added.entersDailyOn)}</strong> (the 01:00 ET reset), so today's challenge stays the same for everyone.`
      : ' Practice can play it right now.')
    : '';
  const head = added
    ? `<h3 class="good">${added.alreadyInRotation ? 'Already in the community rotation' : 'Added to the community rotation'}</h3>
       <p class="muted small">${esc(added.name)} · ${esc(added.commander)} · Bracket ${added.bracket}.${when}</p>`
    : `<h3 class="${report.autoRepaired ? 'warn' : 'bad'}">${report.autoRepaired ? 'Verified after automatic substitutions' : 'Not added to the rotation'}</h3>`;

  box.innerHTML = `
    ${head}
    <ul class="check-list">${rows}</ul>
    ${swaps}
    ${blockers}
    <p class="muted small">Coverage: ${report.coverage ? `${report.coverage.automated}/${report.coverage.total} cards fully scripted` : '—'}
    ${report.coverage && report.coverage.pct === 100 ? '(100% — the bar for the shared rotation)' : ''}</p>`;
}

async function submitImport() {
  const text = $('#importText').value.trim();
  if (!text) { toast('Paste a decklist or a Moxfield / Archidekt URL first.'); return; }
  const btn = $('#btnImport');
  const bracket = $('#importBracket').value;
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  $('#importResult').hidden = false;
  $('#importResult').innerHTML = '<p class="muted small">Checking the list against the rules and the engine…</p>';
  try {
    const body = { text, name: $('#importName').value.trim() || undefined };
    if (bracket) body.bracket = Number(bracket);
    const res = await api('/api/import', body);
    renderImportReport(res.report, res.added);
    toast(res.added ? 'Verified — it is in the rotation.' : 'Checked — see the report.');
    if (res.added) renderCommunity().catch(() => {});
  } catch (e) {
    // A rejected deck comes back as 422 with a full report; show it rather than
    // a bare error, because the report is the whole point of the check.
    if (e.report) renderImportReport(e.report, null);
    else $('#importResult').innerHTML = `<h3 class="bad">Import failed</h3><p class="muted small">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & add to the rotation';
  }
}

async function renderCommunity() {
  const box = $('#communityList');
  if (!box) return;
  const res = await api('/api/community', undefined, 'GET');
  const decks = res.decks || [];
  $('#communityCount').textContent = decks.length ? `· ${decks.length} verified deck${decks.length === 1 ? '' : 's'}` : '· none yet';
  box.innerHTML = decks.length ? decks.map((d) => `
    <div class="deck-mini">
      <div class="deck-swatch" style="background:${d.theme}"></div>
      <div><strong>${esc(d.name)}</strong><br>
        <span class="muted small">${esc(d.commander)} · verified ${d.coverage ? d.coverage.automated : '?'}/${d.coverage ? d.coverage.total : '?'} cards</span></div>
      <span class="b">B${d.bracket}</span>
    </div>`).join('')
    : '<p class="muted small">No community decks yet — the first verified upload appears here and joins the rotation.</p>';
}

function renderVoteInto(sel) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML = S.boot.vote.options.map((o) => `<button class="vote-opt ${S.boot.vote.myVote === o.id ? 'chosen' : ''}" data-id="${o.id}">
      <span class="deck-swatch" style="background:${o.theme}"></span>
      <span><strong>${esc(o.name)}</strong><br><span class="muted small">${esc(o.commander)} · B${o.bracket}</span></span></button>`).join('')
    + `<button class="vote-opt ${S.boot.vote.myVote === 'random' ? 'chosen' : ''}" data-id="random"><span class="deck-swatch" style="background:linear-gradient(90deg,#e63946,#f1faee,#457b9d)"></span><span><strong>Surprise me</strong><br><span class="muted small">Seeded pick</span></span></button>`;
  $$('.vote-opt', box).forEach((b) => b.onclick = async () => {
    const r = await api('/api/vote', { choice: b.dataset.id });
    S.boot.vote.myVote = r.myVote; S.boot.vote.tally = r.tally;
    toast('Vote counted for tomorrow.');
    renderVoteInto(sel);
  });
}

wire();
boot().catch((e) => {
  document.body.classList.remove('loading');
  openModal(`<h1>Could not load</h1><p class="muted">${esc(e.message)}</p>`);
});
