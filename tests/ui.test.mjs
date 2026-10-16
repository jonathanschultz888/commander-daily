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

test('a card on the table shows its artwork and its rules text', () => {
  // The complaint that started this: hand cards rendered as a name and nothing
  // else. Two causes, both in the stylesheet — the art was faded to 38% and the
  // rules text was switched off entirely on narrow screens.
  const art = css.match(/\.card \.art \{([^}]*)\}/);
  assert.ok(art, '.card .art exists');
  const opacity = art[1].match(/opacity:\s*([\d.]+)/);
  assert.ok(!opacity || Number(opacity[1]) >= 0.9, `artwork must not be washed out (opacity: ${opacity && opacity[1]})`);
  // "Filling the card" now means filling it with the *picture*: the tile blows the
  // card image up to the artwork window (260% / centre 19%) instead of using a plain
  // `cover`, which showed the card's frame and type line as a blurry copy of itself.
  assert.ok(/background-size:\s*(cover|\d{3}%)/.test(art[1]), `and it is drawn to fill the card (${art[1].match(/background-size:[^;]*/)})`);
  assert.ok(/background-position:\s*50% 19%/.test(art[1]), 'framed on the artwork window rather than the frame');
  assert.ok(/\.card \.art::after/.test(css), 'with a scrim so the text on top stays readable');

  // Nothing anywhere may hide the rules text — media query or otherwise.
  for (const m of css.matchAll(/\.card \.text[^{]*\{([^}]*)\}/g)) {
    assert.ok(!/display:\s*none/.test(m[1]), 'the rules text is never hidden');
  }
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/\.slice\(0, 190\)/.test(app), 'the client no longer truncates card text to 190 characters');
  assert.ok(/function trimOracle|trimOracle\(/.test(app), 'card text goes through trimOracle');
  assert.ok(/oracle_text/.test(app), 'and it is the real oracle text');
});

test('the pass-priority and action controls live in the middle of the table', () => {
  // They used to sit in the sidebar, which on a phone is a bottom sheet: passing
  // priority meant opening a sheet and scrolling. Everything pressable is now in
  // the prompt dock between the two boards.
  assert.ok(!/id="btnPass"/.test(html), 'the sidebar no longer carries the pass button');
  assert.ok(/id="promptBar"/.test(html), 'the dock exists');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const bar = app.slice(app.indexOf('function renderPromptBar'), app.indexOf('/**', app.indexOf('function renderPromptBar') + 10));
  assert.ok(/dock-actions/.test(bar), 'priority actions render into the dock');
  assert.ok(/dock-chip/.test(bar), 'as buttons');
  assert.ok(/dockPass/.test(bar), 'with pass priority in the same place');
  assert.ok(/declareAttackers/.test(bar) && /declareBlockers/.test(bar), 'combat prompts keep their home there');
  const prompt = css.match(/\.prompt-bar \{([^}]*)\}/);
  assert.ok(prompt, '.prompt-bar is styled');
  assert.ok(/position:\s*sticky/.test(prompt[1]), 'the dock sticks to the viewport');
  assert.ok(/z-index/.test(prompt[1]), 'and stacks above the boards');
});

test('a player can report a card, and the client shows the engine verdict', () => {
  // "There must be a player-facing way to report a card behaving incorrectly, and
  // the system checks the correct behaviour." The affordance lives on the card
  // inspector (where a player is already looking at the card) and the answer is
  // rendered in the page — never a native dialog, which iframes block.
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/id="btnReportCard"/.test(app), 'the inspector offers a report button');
  assert.ok(/function reportCard\(/.test(app), 'and there is a report flow');
  assert.ok(/api\/report-card/.test(app), 'which posts to the report endpoint');
  assert.ok(/name: card\.name/.test(app), 'naming the card it is about');
  assert.ok(/function reportVerdictHtml\(/.test(app), 'the verdict is rendered as markup');
  assert.ok(/out\.findings/.test(app), 'including the engine findings, not just a thank-you');
  // the styles it relies on exist
  assert.ok(/\.report-row\b/.test(css) && /\.report-verdict\b/.test(css), 'and it is styled');
});

/* ------------------------------------------------------------------ *
 * Round 4: the things the player asked for by name.
 * ------------------------------------------------------------------ */

test('the side panels fold away and stay folded', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const blocks = [...html.matchAll(/<details class="panel[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(blocks.includes('railPoints'), 'points is a foldable block');
  assert.ok(blocks.includes('railMatch'), 'so is the match panel');
  assert.ok(blocks.includes('railLog'), 'and the log');
  assert.ok(/<summary>/.test(html), 'each one has a summary to click');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/localStorage\.setItem\(RAIL_KEY/.test(app), 'the open/closed state is remembered');
  assert.ok(/rail-hidden/.test(app) && /rail-hidden/.test(css), 'and the whole rail can be hidden from the strip');
});

test('the three sections are buttons at the top, and reachable from inside a game', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const pane of ['daily', 'practice', 'tools']) {
    assert.ok(new RegExp(`data-pane="${pane}"`).test(html), `${pane} is one of the three buttons`);
  }
  assert.ok(/Daily Challenge/.test(html) && /Practice/.test(html) && /Tools/.test(html), 'and they are labelled for a human');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of ['stripDaily', 'stripPractice', 'stripTools', 'gameLobbyBtn']) {
    assert.ok(new RegExp(`#\\$?\\{?.*${id}|${id}`).test(html + app), `${id} exists and is wired`);
  }
  assert.ok(/leaveTo|leaveGameTo/.test(app), 'leaving the board from inside a game is wired up');
});

test('a card states its own power, toughness, keywords and counters', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/function keywordBadges/.test(app) && /keywordBadges\(card\)/.test(app), 'keyword badges are drawn on the card');
  assert.ok(/function counterPips/.test(app) && /counterPips\(card\)/.test(app), 'counter pips are drawn on the card');
  assert.ok(/counterList/.test(app), 'and they come from the engine\'s own counter list, not a guess');
  assert.ok(/isCreatureNow/.test(app), 'a land that has been animated shows a power/toughness while it is a creature');
  assert.ok(/temp.*⧗|⧗/.test(app), 'a counter that expires is marked as temporary');
  // the engine has to keep sending those fields
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  for (const field of ['counterList', 'keywordsPrinted', 'printed', 'animated', 'powerDelta|tempBonus']) {
    assert.ok(new RegExp(field).test(server), `the view carries ${field}`);
  }
});

test('blocking can be assigned in either order, and the pair is visible', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // Both halves of the pair respond to a tap. This assertion used to pin the
  // guard `declareBlockers' && p.id === S.view.humanId`, which is exactly the bug
  // (it wired only your own side, so the attacker could never be tapped): the
  // branch has to run on both boards and let the role checks do the filtering.
  assert.ok(!/declareBlockers' && p\.id === S\.view\.humanId/.test(app),
    'the block branch is not limited to your own permanents');
  assert.ok(/declareBlockers'\)\s*\{/.test(app), 'both the attacker and the blocker are clickable');
  assert.ok(/onBlockerTap/.test(app), 'which runs the block chooser');
  assert.ok(/role: isMyCreature \? 'blocker' : 'attacker'/.test(app),
    'and the chooser knows which half it is holding, so order does not matter');
  assert.ok(/const blocker = isMyCreature \? iid : pick/.test(app) && /const attacker = isAttacker \? iid : pick/.test(app),
    'the pair is assembled from whichever end was tapped');
  assert.ok(/pair-chip/.test(app) && /pair-chip/.test(css), 'assigned blocks are listed as chips that can be undone');
  assert.ok(/Confirm \\$\\{S\.blocks\.length\\}|Confirm \$\{S\.blocks\.length\}/.test(app), 'and confirmed in one press');
});

test('there is an attack-with-everything button', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/id="attackAll"/.test(app), 'the dock offers it');
  assert.ok(/S\.attackers = new Set\(wasAll \? \[\] : legal\)/.test(app),
    'and it selects exactly the creatures the engine says may attack (never a tapped one, never a 0-power one)');
});

test('an opponent aiming at you opens a popup with your legal responses', () => {
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  assert.ok(/function threatFor/.test(server), 'the server works out when the human is being targeted');
  assert.ok(/threat: threatFor\(game\)/.test(server), 'and sends it with the view');
  assert.ok(/instant: isInstantSpeedAction/.test(server), 'every legal action says whether it can be played in response');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/function maybeShowThreat/.test(app) && /maybeShowThreat\(\)/.test(app), 'the client pops it up');
  assert.ok(/Let it resolve|threatAllow/.test(app), 'and always offers the "do nothing" way out');
  assert.ok(/\.opt\.respond|opt respond/.test(app), 'the responses are the same buttons used everywhere else');
});

test('a card can be reviewed on the fly, and the check runs again on demand', () => {
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  assert.ok(/\/api\/card-check/.test(server), 'the card-check endpoint exists');
  assert.ok(/\/recheck/.test(server) && /recheck/.test(server), 'and a recheck path re-derives the analysis');
  const explain = fs.readFileSync(new URL('../src/engine/explain.js', import.meta.url), 'utf8');
  assert.ok(/export function explainCard/.test(explain), 'the engine can explain a card in words');
  assert.ok(/gaps:/.test(explain), 'including the clauses it cannot read — honesty is the point');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/function cardCheck/.test(app), 'the client has the screen');
  assert.ok(/Check this card again/.test(app), 'with a button that runs the check again');
  assert.ok(/How does this card work/.test(app), 'and a way in from the card sheet');
});


/* ------------------------------------------------------------------ */
/* Round 5: the rail leaves sideways, the cards got bigger, tokens     */
/* pile up, the command zone and the graveyard are readable, and a     */
/* search opens a sheet over the field                                 */
/* ------------------------------------------------------------------ */

test('folding the rail retracts it sideways instead of leaving a column of headers', () => {
  const round4 = css.indexOf('body.rail-hidden .sidebar { display: none; }');
  const round5 = css.indexOf('display: grid; overflow: hidden; width: 38px;');
  assert.ok(round4 > -1, 'round 4 hid the rail outright');
  assert.ok(round5 > round4, 'and round 5 takes over that rule, after it');
  const block = css.slice(css.lastIndexOf('body.rail-hidden .sidebar {', round5), css.indexOf('}', round5));
  assert.ok(/display:\s*grid/.test(block),
    'a later rule cannot undo a property it does not declare: `display` must be restated or the rail stays display:none');
  assert.ok(/body\.rail-hidden \.sidebar > \*:not\(\.game-strip\)\s*\{[^}]*transform:\s*translateX/.test(css),
    'the panels are translated off the right edge');
  assert.ok(/body\.rail-hidden \.game \{ grid-template-columns: minmax\(0, 1fr\) 38px/.test(css),
    'and the board takes the width the rail was using');
  assert.ok(/body\.rail-hidden \.sidebar \.strip-btn \.btn-text \{ display: none/.test(css),
    'what is left is a slim icon strip');
  assert.ok(/\.rail-peek/.test(css) && /id="railPeek"/.test(html),
    'and a tab on the edge of the table to bring the panels back');
});

test('the permanents on the table are bigger than the cards in hand, and whole', () => {
  const handSize = css.match(/\.card \{\s*--card-w: 100px; --card-h: 140px;/);
  assert.ok(handSize, 'the hand keeps its size');
  // The size lives on the player's section now, and the board cards inherit it: a
  // variable declared on `.card` itself cannot be overridden by a value inherited
  // from above it, so `--card-w: inherit` is what makes the section's size win.
  const table = css.match(/\.side \{ --card-w: (\d+)px; --card-h: (\d+)px; \}/);
  assert.ok(table, 'the section declares the size of the cards standing in it');
  assert.ok(Number(table[1]) > 100 && Number(table[2]) > 140,
    `a permanent is drawn bigger than a card in hand (${table[1]}x${table[2]})`);
  assert.ok(/\.zone-cards \.card \{ --card-w: inherit; --card-h: inherit; \}/.test(css),
    'and the cards take that size rather than their own');
  assert.ok(/\.zone-cards \.card \+ \.card \{ margin-left: -9px; \}/.test(css),
    'the overlap between permanents is halved so the name stays readable');
  // The bug this pins: a 166px card in a 129px lane, with the wrapper's
  // overflow:hidden cutting off exactly the bottom of the card — the printed P/T.
  assert.ok(/\.side \.board \{ min-height: calc\(var\(--card-h\) \+ 2\.6rem\); \}/.test(css),
    'the board cannot shrink below one card plus its label');
  assert.ok(/@media \(max-height: 800px\) \{\s*\.side \{ --card-w: 96px; --card-h: 134px; \}/.test(css),
    'short windows still shrink the table rather than scroll it');
  assert.ok(/@media \(max-width: 720px\) \{\s*\.side \{ --card-w: 92px; --card-h: 128px; \}/.test(css),
    'and a phone shrinks it further');
  assert.ok(/\.zone-cards \{ scrollbar-width: thin; \}/.test(css) &&
    /\.zone-cards::-webkit-scrollbar \{ height: 8px; \}/.test(css),
    'a lane that scrolls sideways reserves a thin scrollbar, not a 15px slab over the cards');
});

test('identical tokens draw as one pile that is still selectable per token', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/const stackKey = \(c\) => \{/.test(app), 'tokens are keyed by what makes them identical');
  assert.ok(/if \(!c\.isToken\) return null;/.test(app), 'only tokens pile up — two real cards never merge');
  assert.ok(/stack-group/.test(app) && /stack-count/.test(app), 'the pile is one face with a count badge');
  assert.ok(/×\$\{group\.cards\.length\}/.test(app), 'and the badge says how many are in it');
  assert.ok(/const pips = el\('div', 'stack-pips'\)/.test(app) && /el\('button', 'stack-pip'/.test(app),
    'with one chip per token underneath');
  assert.ok(/pip\.dataset\.token = c\.iid/.test(app), 'each chip is a specific token, by id');
  assert.ok(/wire\(c, pip\)/.test(app),
    'and answers every click the card face answers: target, attack, block, sacrifice, activate');
  assert.ok(/const on = mine\.every\(\(c\) => S\.attackers\.has\(c\.iid\)\)/.test(app),
    'the pile face is the whole pile: clicking it attacks with all of it');
  // 17px square, on a dark bar so a light chip reads on any artwork: at 13px on
  // dark token art the chips were there but invisible.
  assert.ok(/\.stack-pip \{[\s\S]{0,240}min-width: 17px; min-height: 17px/.test(css),
    'the chips are big enough to hit');
  assert.ok(/\.stack-pips \{[\s\S]{0,400}linear-gradient\(to top/.test(css),
    'and sit on a dark bar so they are legible over the token\'s art');
});

test('the command zone is always on screen, and the graveyard shows its top card', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/const cmd = p\.command \|\| \[\];/.test(app), 'the command zone is read on every render');
  assert.ok(/command zone empty/.test(app) && /is on the battlefield/.test(app),
    'an empty command zone says so, and says where the commander is');
  assert.ok(/tax \+\$\{cmd\[0\]\.castFromCommandZone\}/.test(app), 'a commander in the zone shows its tax');
  assert.ok(/const grave = p\.graveyard \|\| \[\];/.test(app) && /⚰ \$\{grave\.length\}/.test(app),
    'the graveyard shows its size');
  assert.ok(/\$\{top \? ` · \$\{esc\(top\.name\)\}` : ''\}/.test(app), 'and the top card of the pile');
  assert.ok(/\.pile\.cmd \{/.test(css) && /\.pile\.grave\.live \{/.test(css), 'both are drawn as their own kind of pile');
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  assert.ok(/castFromCommandZone/.test(server), 'the view carries the commander tax');
});

test('a search opens a sheet over the field listing every legal card', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(/function renderChoice\(\)/.test(app), 'the client draws the engine\'s question');
  assert.ok(/const m = S\.view\?\.modal;/.test(app), 'driven by view.modal');
  assert.ok(/function chooseHtml/.test(app) && /\.choose-grid/.test(css), 'the search sheet is a grid of card faces');
  assert.ok(/not a legal pick/.test(app) && /class="choose-rest"/.test(app),
    'the cards that are not legal picks are still inspectable, in a folded list');
  assert.ok(/choose-ask/.test(app) && /Pick \$\{need - sel\.length\} more/.test(app),
    'and a multi-card search says how many are still to pick');
  assert.ok(/await sendAction\(\{ type: 'choose', picks: sel\.picks \}\)/.test(app),
    'answering posts a choose action');
  assert.ok(/function topXHtml/.test(app) && /data-flip/.test(app), '"look at the top N" draws two rows');
  assert.ok(/topLabel/.test(app) && /mini-move/.test(app),
    'with the order shown left to right and arrows to reorder');
  assert.ok(/await sendAction\(\{ type: 'choose', picks: sel\.top, top: sel\.top, bottom: sel\.bottom \}\)/.test(app),
    'and the answer is the order the spell dictates');
  assert.ok(/if \(S\.view\?\.modal\) return;/.test(app),
    'a question from the engine cannot be dismissed with Escape or a backdrop click');
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  assert.ok(/function decorateModal/.test(server), 'the server turns the engine\'s card ids into card faces');
  assert.ok(/modal: game\.modal \? decorateModal\(game, game\.modal\) : null/.test(server), 'and ships them in the view');
});

test('the engine asks the human seat and nobody else', () => {
  const ops = fs.readFileSync(new URL('../src/engine/ops.js', import.meta.url), 'utf8');
  assert.ok(/export function askChoice/.test(ops), 'there is one place a seat is asked to pick');
  assert.ok(/const humanSeat = playerId === g\.humanId && g\.interactive === true && !g\.humanIsBot;/.test(ops),
    'only the human seat, only after the takeover, only in a game a person is playing');
  assert.ok(/export class DeferResolution/.test(ops), 'and the suspension it needs is explicit');
  assert.ok(/export function resumeDeferred/.test(ops), 'the rest of the effect resumes after the answer');
  assert.ok(/export function rebuildPendingChoice/.test(ops),
    'a question can be re-created from data, so a reload does not lose it');
  const driver = fs.readFileSync(new URL('../src/engine/driver.js', import.meta.url), 'utf8');
  assert.ok(/case 'choose':/.test(driver), 'the choose action travels the same path as every other action');
  assert.ok(/if \(game\.modal\) return \{ status: 'awaiting' \};/.test(driver), 'and the world stops while the player decides');
  const server = fs.readFileSync(new URL('../src/server/server.js', import.meta.url), 'utf8');
  assert.ok(/game\.interactive = !game\.humanIsBot && game\.status !== 'over';/.test(server),
    'the human seat only starts answering after the scripted opening');
});

test('both halves of a block are clickable — the attacker is not filtered to your own permanents', () => {
  // The hands-on-table freeze in reverse: blocking "worked" only for the half of
  // the pair that lives on your side. The branch that wires a creature for a block
  // was guarded with `p.id === S.view.humanId`, so an attacking creature — always a
  // permanent on the opponent's board — never received the class or the click
  // handler, and neither tap order could ever complete a pair.
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const start = app.indexOf("else if (S.pending?.type === 'declareBlockers'");
  assert.ok(start > 0, 'the blocking branch exists');
  const branch = app.slice(start, start + 900);
  const condition = branch.slice(0, branch.indexOf(') {'));
  assert.ok(!/p\.id === S\.view\.humanId/.test(condition),
    'the block branch must run on both sides of the table, not only on yours');
  assert.match(branch, /isAttacker = \(S\.pending\.attackers \|\| \[\]\)\.includes\(c\.iid\)/);
  assert.match(branch, /isMyCreature = p\.id === S\.view\.humanId && \(S\.pending\.blockers \|\| \[\]\)\.includes\(c\.iid\)/);
  // and the handler itself has to accept either order
  const tap = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const fn = tap.slice(tap.indexOf('function onBlockerTap'), tap.indexOf('function cardNameFor'));
  assert.match(fn, /const blocker = isMyCreature \? iid : pick;/);
  assert.match(fn, /const attacker = isAttacker \? iid : pick;/);
});

test('the search sheet takes its clothes off when it closes', () => {
  // `renderChoice` dressed `#modal` in `.choice-sheet` and nothing undressed it, so
  // after one search every ordinary pop-up — card menu, block confirm, threat
  // review, points tracker, the card report — came up as a top-aligned sheet with
  // no ✕ and the sheet's scroll box. Two classes, two places to clear them.
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const open = app.slice(app.indexOf('function openModal'), app.indexOf('function closeModal'));
  assert.ok(/\$\('#modal'\)\.classList\.remove\('choice-sheet'\);/.test(open),
    'an ordinary pop-up drops the sheet class before it draws');
  const close = app.slice(app.indexOf('function closeModal'), app.indexOf('function closeModal') + 600);
  assert.ok(/\$\('#modal'\)\.classList\.remove\('choice-sheet'\);/.test(close),
    'and closing clears it too');
  assert.ok(/S\.choice = null;/.test(close), 'and the local selection goes with it');
  assert.ok(/\$\('#modal'\)\.classList\.add\('choice-sheet'\);/.test(app),
    'while the sheet itself still wears it');
  // Escape and the backdrop must still be refused while the engine is waiting
  assert.ok(/if \(S\.view\?\.modal\) return;/.test(close),
    'the refusal to dismiss an engine question comes first');
});
