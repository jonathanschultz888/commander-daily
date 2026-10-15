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
function applyTheme(hex) {
  if (!hex) return;
  const { r, g, b } = hexToRgb(hex);
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-soft', `rgba(${r},${g},${b},0.16)`);
  root.setProperty('--accent-glow', `rgba(${r},${g},${b},0.45)`);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', '#0b0f14');
}

/* ---------------- countdown to 01:00 ET ---------------- */
function startClock(msUntilReset) {
  let target = Date.now() + (msUntilReset || 0);
  const tick = () => {
    const left = Math.max(0, target - Date.now());
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000), s = Math.floor((left % 60000) / 1000);
    $('#resetClock').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
  applyTheme(S.boot.daily.botDeck.theme);
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
  $('#matchup').innerHTML = `
    <div class="duelist"><div class="role">You pilot</div><div class="name">${esc(you.name)}</div><div class="cmdr">${esc(you.commander)}</div><div class="pill-row"><span class="pill">Bracket ${you.bracket}</span></div></div>
    <div class="vs">VS</div>
    <div class="duelist bot"><div class="role">Bot · themes the site</div><div class="name">${esc(bot.name)}</div><div class="cmdr">${esc(bot.commander)}</div><div class="pill-row"><span class="pill accent">Bracket ${bot.bracket}</span><span class="pill">${esc(bot.themeName)}</span></div></div>`;
  $('#dailyFineprint').textContent = `One scored attempt, resets at 1:00 am ET. Practice is unlimited and never counts.`;

  // deck list
  $('#deckCards').innerHTML = S.boot.decks.map((dk) => `
    <div class="deck-mini">
      <div class="deck-swatch" style="background:${dk.theme}"></div>
      <div><strong>${esc(dk.name)}</strong><br><span class="muted small">${esc(dk.commander)}</span></div>
      <span class="b">B${dk.bracket}</span>
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
  applyTheme(S.view.players[1]?.theme || S.boot.daily.botDeck.theme);
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
    <div class="cost">${esc(card.mana_cost || '')}</div>
    <div class="type">${esc(card.type_line || '')}</div>
    <div class="text">${esc((card.oracle_text || '').replace(/\n/g, ' ')).slice(0, 190)}</div>
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

function renderHand(me) {
  const wrap = $('#myHand');
  wrap.innerHTML = '';
  const count = $('#handCount');
  if (count) count.textContent = `${me.hand.length} card${me.hand.length === 1 ? '' : 's'}`;
  const playable = new Map();
  for (const a of (S.pending?.type === 'priority' ? S.pending.actions : [])) {
    if (a.type === 'playLand' || a.type === 'cast') playable.set(a.iid, a);
  }
  for (const c of me.hand) {
    const n = cardEl(c, { inHand: true });
    const act = playable.get(c.iid);
    if (act) {
      n.classList.add('playable');
      n.draggable = false;
    }
    n.dataset.playable = act ? '1' : '';
    n.addEventListener('pointerdown', (ev) => onHandPointerDown(ev, n, c, act));
    wrap.appendChild(n);
  }
  if (!me.hand.length) wrap.appendChild(el('div', 'muted small', 'Empty hand — topdeck mode.'));
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
      const act = S.pending.actions.find((a) => a.type === 'activate' && a.iid === c.iid);
      if (act) {
        n.style.cursor = 'pointer';
        n.classList.add('playable');
        n.addEventListener('click', () => chooseAction(act));
      }
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
  wrap.innerHTML = me.manaPool.length
    ? `<span class="muted small">Mana pool:</span> ${me.manaPool.map((c) => `<span class="mana-pip">${c}</span>`).join('')}`
    : `<span class="muted small">Mana empties at the end of each step — lands are tapped automatically for you.</span>`;
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

function renderLog() {
  const me = { 0: 'mine' };
  $('#logFeed').innerHTML = (S.view.log || []).slice(-24).map((l) => `<div class="e ${l.kind === 'points' ? 'pts' : ''}"><span class="muted">T${l.turn}</span> ${esc(l.text)}</div>`).join('');
}

function renderCombos() {
  const feed = $('#comboFeed');
  const combos = (S.view.combos || []).filter((c) => c.player === 0);
  const oppCombos = (S.view.combos || []).filter((c) => c.player === 1);
  feed.innerHTML = [
    ...combos.map((c) => `<div class="combo-item">You: ${esc(c.name)} <span class="muted">T${c.turn}</span></div>`),
    ...oppCombos.map((c) => `<div class="combo-item" style="opacity:.7">Opponent: ${esc(c.name)} <span class="muted">T${c.turn}</span></div>`),
  ].join('');
}

function renderActions() {
  const box = $('#actionChips');
  const p = S.pending;
  box.innerHTML = '';
  if (!p || p.type !== 'priority') {
    $('#btnPass').hidden = !!p; // hide pass while a special prompt owns the UI
    return;
  }
  $('#btnPass').hidden = false;
  const acts = p.actions || [];
  if (!acts.length) { box.appendChild(el('p', 'muted small', 'Nothing to play — pass to continue.')); return; }
  for (const a of acts) {
    const chip = el('button', 'chip', `<span class="mana">${esc(a.mana || '')}</span>${esc(a.label)}`);
    if (a.x || a.needsX) chip.innerHTML += ' <span class="muted small">X</span>';
    chip.onclick = () => chooseAction(a);
    box.appendChild(chip);
  }
}

function renderPromptBar() {
  // The server no longer offers a priority window with no legal action, but the
  // client stays defensive: a prompt with nothing but "pass" is noise, so it is
  // not rendered at all.
  if (S.pending?.type === 'priority' && !(S.pending.actions || []).some((a) => a.type !== 'pass')) {
    const bar = $('#promptBar');
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const bar = $('#promptBar');
  const p = S.pending;
  if (!p || p.type === 'priority') { bar.hidden = true; return; }
  bar.hidden = false;
  if (S.targeting) {
    bar.innerHTML = `<span class="grow">🎯 Choose a target for <strong>${esc(S.targeting.action.name)}</strong></span>
      <button class="ghost tiny" id="cancelTarget">Cancel</button>`;
    $('#cancelTarget').onclick = () => { S.targeting = null; renderGame(); };
    return;
  }
  if (p.type === 'declareAttackers') {
    bar.innerHTML = `<span class="grow">⚔ Declare attackers — tap your creatures, then confirm. Opponent at ${p.defenderLife} life.</span>
      <button class="primary" id="confirmAttack">Attack with ${S.attackers.size}</button>
      <button class="ghost tiny" id="clearAttack">None</button>`;
    $('#confirmAttack').onclick = () => send({ type: 'attackers', iids: [...S.attackers] });
    $('#clearAttack').onclick = () => { S.attackers.clear(); send({ type: 'attackers', iids: [] }); };
    return;
  }
  if (p.type === 'declareBlockers') {
    bar.innerHTML = `<span class="grow">🛡 Declare blockers — tap one of your creatures, then tap the attacker it blocks. (${S.blocks.length} assigned)</span>
      <button class="primary" id="confirmBlocks">Confirm blocks</button>
      <button class="ghost tiny" id="clearBlocks">No blocks</button>`;
    $('#confirmBlocks').onclick = () => send({ type: 'blockers', pairs: S.blocks });
    $('#clearBlocks').onclick = () => { S.blocks = []; send({ type: 'blockers', pairs: [] }); };
  }
}

function inspect(card) {
  openModal(`<h1>${esc(card.name)}</h1>
    <div class="pill-row"><span class="pill accent">${esc(card.mana_cost || '')}</span><span class="pill">${esc(card.type_line || '')}</span>
    ${card.isCommander ? '<span class="pill accent">Commander</span>' : ''}${card.isToken ? '<span class="pill">Token</span>' : ''}</div>
    <p style="white-space:pre-wrap">${esc(card.oracle_text || 'No rules text.')}</p>
    ${card.power != null ? `<p class="muted">Power/toughness: ${card.power}/${card.toughness}</p>` : ''}`);
}

/* ==========================================================================
   INTERACTION — select, drag, target, act
   ========================================================================== */
function onHandPointerDown(ev, node, card, action) {
  if (!action) { inspect(card); return; }
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
    chooseAction(action); // tap = select
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function chooseAction(action) {
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
  return { type: 'activate', iid: a.iid, index: a.index };
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
  sendAction({ ...toSend(t.action), targets: [ref] });
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
    <div style="margin-top:1rem"><button class="ghost" id="viewBoard">Look at the final board</button></div>`);
  const nameInput = $('#playerName');
  if (nameInput) {
    nameInput.value = localStorage.getItem('cd_name') || '';
    nameInput.focus();
  }
  $('#viewBoard').onclick = closeModal;
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
  $('#btnPass').onclick = sendPass;
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

  $('#btnBackToLobby').onclick = async () => {
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

  const sb = $('#sidebar');
  $('#sidebarHandle').onclick = () => sb.classList.toggle('open');
  // swipe up on mobile to open the panel
  let sy = null;
  $('#game').addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; }, { passive: true });
  $('#game').addEventListener('touchend', (e) => {
    if (sy == null) return;
    const dy = sy - e.changedTouches[0].clientY;
    if (dy > 70 && e.changedTouches[0].clientY > window.innerHeight - 90) sb.classList.add('open');
    else if (dy < -70) sb.classList.remove('open');
    sy = null;
  }, { passive: true });
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
