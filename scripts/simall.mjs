/** Play every same-bracket pair several times and report crashes + win rates. */
import { loadAllDecks } from '../src/decks/index.js';
import { createGame } from '../src/engine/game.js';
import { runEngine } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';

const decks = loadAllDecks();
const byBracket = {};
for (const d of decks) (byBracket[d.bracket] ||= []).push(d);

let games = 0, crashes = 0, stalls = 0, overGames = 0, totalTurns = 0;
const t0 = Date.now();
for (const [bracket, list] of Object.entries(byBracket)) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (const seed of [1, 7, 42]) {
        games++;
        try {
          const g = createGame({ decks: [list[i], list[j]], seed: seed * 1000 + i * 10 + j, options: { humanIsBot: true } });
          g.bot = makeBot(list[j].prototype);
          const res = runEngine(g, { stopForHuman: false, maxIterations: 30000 });
          if (res.status === 'over') { overGames++; totalTurns += g.turn; }
          else stalls++;
          const unsup = [...g.unsupported];
          if (unsup.length && games % 7 === 0) console.log(`    unsupported ops seen: ${unsup.join(', ')}`);
        } catch (e) {
          crashes++;
          console.log(`CRASH B${bracket} ${list[i].id} vs ${list[j].id} seed ${seed}: ${e.message}`);
          console.log('   ', (e.stack || '').split('\n')[1]?.trim());
        }
      }
    }
  }
}
console.log(`\n${games} games in ${((Date.now() - t0) / 1000).toFixed(1)}s | finished ${overGames} | stalls ${stalls} | crashes ${crashes} | avg turns ${(totalTurns / Math.max(1, overGames)).toFixed(1)}`);
