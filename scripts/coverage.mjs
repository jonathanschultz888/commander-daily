/**
 * Card coverage report.
 * Walks every card in the seed pool and reports how completely the engine
 * automates it: hand-scripted/compiled behaviour vs. oracle phrases it could
 * not parse. Writes src/data/coverage.json for the site's info panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAllDecks } from '../src/decks/index.js';
import { cardScript } from '../src/engine/scripts.js';
import { HAND_SCRIPTS } from '../src/engine/scripts.js';

const decks = loadAllDecks();
const seen = new Map();
for (const deck of decks) for (const card of deck.cardList) if (!seen.has(card.name)) seen.set(card.name, card);

const rows = [];
for (const [name, card] of seen) {
  const s = cardScript(card);
  const isHand = !!HAND_SCRIPTS[name.toLowerCase()];
  const behaviours = (s.mana.length ? 1 : 0) + s.abilities.length + s.triggers.length + s.statics.length
    + (s.steps?.length ? 1 : 0) + (s.onEnter ? 1 : 0) + (s.onDeath ? 1 : 0) + (s.tokenDoubler ? 1 : 0)
    + (s.entersTapped ? 1 : 0) + (s.extraLandDrops ? 1 : 0);
  const status = s.unsupported.length === 0 ? (isHand ? 'scripted' : behaviours ? 'compiled' : 'vanilla')
    : (behaviours || s.unsupported.length < 2 ? 'partial' : 'unhandled');
  rows.push({ name, status, hand: isHand, behaviours, unsupported: s.unsupported, type: card.type_line });
}

const counts = rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
const phrases = new Map();
for (const r of rows) for (const u of r.unsupported) phrases.set(u, (phrases.get(u) || 0) + 1);

const report = {
  generated: new Date().toISOString(),
  decks: decks.length,
  uniqueCards: rows.length,
  counts,
  fullyAutomated: counts.scripted + counts.compiled + counts.vanilla,
  pct: Math.round(((counts.scripted + counts.compiled + counts.vanilla) / rows.length) * 100),
  topUnparsed: [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([phrase, n]) => ({ phrase, n })),
  partial: rows.filter((r) => r.unsupported.length).sort((a, b) => b.unsupported.length - a.unsupported.length).slice(0, 60)
    .map((r) => ({ name: r.name, status: r.status, unsupported: r.unsupported })),
};
fs.mkdirSync(path.join(process.cwd(), 'src', 'data'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'src', 'data', 'coverage.json'), JSON.stringify(report, null, 2));

console.log(`Coverage across ${report.uniqueCards} unique cards in ${decks.length} decks`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}  ${Math.round((v / rows.length) * 100)}%`);
console.log(`  fully automated: ${report.pct}%`);
console.log('\nMost common oracle phrases the compiler does not handle:');
for (const { phrase, n } of report.topUnparsed.slice(0, 12)) console.log(`  ${String(n).padStart(3)}x  ${phrase.slice(0, 96)}`);
