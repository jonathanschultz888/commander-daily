/** Quick smoke check: load decks, report brackets/combos, run one game. */
import { loadAllDecks } from '../src/decks/index.js';
import { createGame } from '../src/engine/game.js';
import { runEngine } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';

const decks = loadAllDecks();
for (const d of decks) {
  console.log(`[B${d.bracket}] ${d.name.padEnd(24)} ${d.total} cards · ${d.uniqueCards} unique · GC:${d.profile.gameChangers.length} · combos:${d.profile.combos.length} · cmd: ${d.commander}`);
}
const g = createGame({ decks: [decks[0], decks[1]], seed: 20261015, options: { humanIsBot: true } });
g.bot = makeBot(decks[1].prototype);
const res = runEngine(g, { stopForHuman: false, maxIterations: 30000 });
console.log(`\nsmoke game: ${res.status} after ${g.turn} turns · ${g.result ? (g.result.humanWon ? decks[0].name : decks[1].name) + ' wins' : 'unfinished'} · ${g.logLines.length} log lines`);
