/**
 * UI tests. Run with: npm test
 *
 * These exist because a real bug shipped that every other test in this suite
 * could not see: the whole site rendered as a blank screen in a browser, while
 * the server, the API and the DOM state were all perfectly correct.
 *
 * The cause was CSS. Browsers implement the `hidden` attribute as
 * `display: none` in their *user-agent* stylesheet, and **any author `display`
 * declaration overrides it** — `.modal-backdrop { display: grid }` (a fixed,
 * dark, blurred, full-viewport overlay) therefore painted over the site on
 * load, and `hidden` did nothing. No amount of DOM-level testing can catch
 * that: node/jsdom's getComputedStyle deliberately reorders `[hidden]` to work
 * around "our lack of specificity support", so it reports the bug as fixed.
 *
 * So this reads the stylesheet and the markup as text and enforces the rule
 * the browser actually applies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

/** Every `class`/`id` on an element carrying the hidden attribute. */
function hiddenElements() {
  const out = [];
  // tags can contain > inside attribute values in theory; this markup is simple enough
  for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
    if (!/\shidden(\s|=|>)/i.test(tag)) continue;
    if (/aria-hidden/i.test(tag)) continue; // that is a different attribute
    const id = tag.match(/\sid="([^"]+)"/i)?.[1] || null;
    const cls = (tag.match(/\sclass="([^"]+)"/i)?.[1] || '').split(/\s+/).filter(Boolean);
    out.push({ id, cls, tag: tag.match(/^<([a-z0-9-]+)/i)[1].toLowerCase() });
  }
  return out;
}

/** All top-level `selector { body }` pairs, with comments stripped. */
function cssRules(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2], index: m.index });
  }
  return rules;
}

const RULES = cssRules(css);

/** Does a bare `.class` / `#id` / `tag` selector declare a non-none display? */
function forcedDisplayOf(el) {
  const bare = new Set([...el.cls.map((c) => `.${c}`), ...(el.id ? [`#${el.id}`] : []), el.tag]);
  const hits = [];
  for (const rule of RULES) {
    for (const sel of rule.selectors) {
      if (!bare.has(sel)) continue;
      const display = rule.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/);
      if (display && display[1].trim() !== 'none') hits.push(`${sel} { display: ${display[1].trim()} }`);
    }
  }
  return hits;
}

test('the [hidden] guard exists and is !important', () => {
  const guard = RULES.find((r) => r.selectors.includes('[hidden]')
    && /display\s*:\s*none\s*!important/.test(r.body));
  assert.ok(guard, 'style.css must contain `[hidden] { display: none !important; }` — '
    + 'without it, any author `display` rule on a hidden element wins and the element stays on screen '
    + '(the modal backdrop covered the whole site).');
});

test('every element using the hidden attribute is actually hidden by the stylesheet', () => {
  const els = hiddenElements();
  assert.ok(els.length >= 4, `expected several hidden elements in index.html, found ${els.length}`);

  // Elements whose class declares a display of its own: without the guard these
  // stay on screen despite `hidden`.
  const forced = els
    .map((el) => ({ el, hits: forcedDisplayOf(el) }))
    .filter((x) => x.hits.length);

  const guard = RULES.find((r) => r.selectors.includes('[hidden]') && /display\s*:\s*none\s*!important/.test(r.body));
  if (forced.length) {
    const named = forced.map(({ el, hits }) => `${el.id ? '#' + el.id : `<${el.tag} class="${el.cls.join(' ')}">`} (${hits.join(', ')})`);
    assert.ok(guard, `these elements carry [hidden] but their class forces them visible, so the [hidden] guard is required:\n    `
      + named.join('\n    '));
  }
});

test('the full-screen overlays are hidden on load, and are the reason the guard exists', () => {
  // Named explicitly: this is the specific rule that blanked the site.
  const backdrop = cssRules(css).find((r) => r.selectors.includes('.modal-backdrop'));
  assert.ok(backdrop, '.modal-backdrop styling is expected in style.css');
  assert.match(backdrop.body, /position\s*:\s*fixed/, 'the modal backdrop is a fixed overlay');
  assert.match(backdrop.body, /inset\s*:\s*0/, 'it covers the viewport');
  assert.ok(/\shidden(\s|=|>)/i.test(html.match(/<div[^>]*id="modalBackdrop"[^>]*>/i)?.[0] || ''),
    'the backdrop must ship with the hidden attribute');
  assert.ok(css.includes('[hidden] { display: none !important; }'),
    'and the guard must be present for that attribute to do anything against `display: grid`');
});

test('the client never relies on setting display to un-hide a [hidden] element', () => {
  // app.js toggles `.hidden`; it must not also try to reveal overlays with inline display.
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const suspects = [...app.matchAll(/style\.display\s*=\s*['"](?!none)/g)];
  assert.equal(suspects.length, 0,
    'app.js sets a non-none inline display; inline styles beat the [hidden] guard, so pair it with removing the attribute instead');
});

/* ------------------------------------------------------------------ */
/* Zone clarity, tabs, and the upload tools                            */
/* ------------------------------------------------------------------ */

test('the battlefield is split into creatures / permanents / lands for both players', () => {
  // Asked for directly: a creature zone at the front, other permanents under it,
  // and lands at the back — for both players, so it is never ambiguous which
  // zone a card is in.
  for (const side of ['my', 'opp']) {
    for (const zone of ['Creatures', 'Other', 'Lands']) {
      const id = `${side}Zone${zone}`;
      assert.ok(html.includes(`id="${id}"`), `#${id} must exist (the ${zone} zone for the ${side} player)`);
      const block = html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${id}"`) + 400);
      assert.ok(/class="zone-label"/.test(block), `#${id} needs a visible label so the zone is self-explanatory`);
      assert.ok(/class="zone-cards"/.test(block), `#${id} needs a card container for the client to render into`);
    }
  }
  // Both creature rows must sit nearest the middle of the table, so the two
  // boards face each other across the combat line. On screen that means: my
  // creatures come first in my section, the opponent's come last in theirs.
  const idx = (id) => html.indexOf(`id="${id}"`);
  const myOrder = ['myZoneCreatures', 'myZoneOther', 'myZoneLands'].map(idx);
  assert.deepEqual([...myOrder].sort((a, b) => a - b), myOrder, 'my zones read creatures → permanents → lands top to bottom');
  const oppOrder = ['oppZoneLands', 'oppZoneOther', 'oppZoneCreatures'].map(idx);
  assert.deepEqual([...oppOrder].sort((a, b) => a - b), oppOrder, "the opponent's zones are mirrored: lands first, creatures last (nearest the middle)");
  assert.ok(idx('myZoneCreatures') < idx('myZoneOther') && idx('myZoneOther') < idx('myZoneLands'), 'creatures are the front row for the player');
  assert.ok(html.includes('zone-front'), 'the creature row is marked as the front line');
});

test('the hand is a separate panel, not part of the battlefield', () => {
  assert.ok(html.includes('class="hand-panel" id="handPanel"'), 'the hand has its own panel');
  const panel = html.slice(html.indexOf('id="handPanel"'), html.indexOf('id="handPanel"') + 600);
  assert.ok(panel.includes('id="myHand"'), 'the hand zone lives inside that panel');
  assert.ok(panel.includes('id="handCount"'), 'and shows how many cards are in it');
  // Structurally: the hand must not be nested inside a .board (the battlefield).
  const boardStart = html.indexOf('id="myBoard"');
  const boardEnd = html.indexOf('id="handPanel"');
  assert.ok(boardStart < boardEnd, 'the hand panel sits after the battlefield board, not inside it');
  const between = html.slice(boardStart, boardEnd);
  assert.ok(!between.includes('id="myHand"'), 'no part of the battlefield contains the hand');
  assert.ok(css.includes('.hand-panel {') && css.includes('.zone {'), 'both have their own styling');
});

test('the lobby is split into Daily, Practice and Tools tabs', () => {
  for (const [pane, label] of [['daily', 'Daily'], ['practice', 'Practice'], ['tools', 'Tools']]) {
    assert.ok(html.includes(`data-pane="${pane}"`), `a ${label} tab must exist`);
    assert.ok(html.includes(`id="pane${pane[0].toUpperCase()}${pane.slice(1)}"`), `the ${label} pane must exist`);
  }
  // The daily tab owns the leaderboard; the tools tab owns voting and uploads.
  const daily = html.slice(html.indexOf('id="paneDaily"'), html.indexOf('id="panePractice"'));
  const tools = html.slice(html.indexOf('id="paneTools"'), html.indexOf('class="site-foot"'));
  assert.ok(daily.includes('id="lobbyLeaderboard"'), 'the Daily tab shows the leaderboard');
  assert.ok(tools.includes('id="voteOptions"'), 'the Tools tab hosts the vote for tomorrow');
  assert.ok(tools.includes('id="importText"') && tools.includes('id="btnImport"'), 'and the deck upload');
  assert.ok(tools.includes('id="communityList"'), 'plus the list of verified community decks');
  assert.ok(!html.includes('id="btnVote"'), 'the old topbar vote shortcut is gone (it lives in Tools now)');
});

test('only one lobby pane is visible at a time and the others ship hidden', () => {
  const panes = [...html.matchAll(/<section class="lobby-pane" id="(\w+)" role="tabpanel"( hidden)?>/g)];
  assert.equal(panes.length, 3, 'three lobby panes');
  assert.equal(panes[0][1], 'paneDaily');
  assert.ok(!panes[0][2], 'the daily pane is the default (not hidden)');
  assert.ok(panes[1][2] && panes[2][2], 'practice and tools start hidden');
  assert.ok(css.includes('.lobby-pane[hidden] { display: none; }'), 'and the CSS keeps hidden panes hidden');
});

test('the client never uses native dialogs, which iframes block', () => {
  // The site is often embedded (including Arena's preview iframe), where
  // window.confirm() returns false without ever showing a dialog — a button
  // wired to it looks broken. The client must ask in the page instead.
  const code = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bwindow\.confirm\s*\(/.test(stripped), 'no window.confirm() — use the in-page dialog');
  assert.ok(!/(^|[^.\w])confirm\s*\(\s*['"`]/.test(stripped), 'no bare confirm("…") call either');
  assert.ok(!/\balert\s*\(/.test(stripped), 'no alert()');
  assert.ok(/function askConfirm\(/.test(code), 'and the in-page confirmation helper exists');
  // It must resolve both ways and be wired to the two places that ask.
  assert.ok(/#askOk'\)\.onclick/.test(code) && (/#askCancel'\)\.onclick/.test(code) || /#askCancel/.test(code)), 'the dialog has both buttons');
  assert.ok(/askConfirm\(\{[\s\S]{0,200}Concede this run/.test(code), 'conceding asks in the page');
  assert.ok(/askConfirm\(\{[\s\S]{0,200}Leave the board/.test(code), 'leaving the board asks in the page');
});
