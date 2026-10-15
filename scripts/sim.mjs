/** Headless simulation harness: bot vs bot, used to debug the rules engine. */
import { loadAllDecks } from '../src/decks/index.js';
import { createGame } from '../src/engine/game.js';
import { runEngine } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';

const decks = loadAllDecks();
const [aId, bId] = process.argv[2] ? [Number(process.argv[2]), Number(process.argv[3])] : [0, 1];
const seed = Number(process.argv[4] || 12345);
const a = decks[aId], b = decks[bId];
const g = createGame({ decks: [a, b], seed, options: { humanIsBot: true } });
g.bot = makeBot(b.prototype);
const t0 = Date.now();
const res = runEngine(g, { stopForHuman: false, maxIterations: 20000 });
const ms = Date.now() - t0;
console.log(`=== ${a.name} (B${a.bracket}) vs ${b.name} (B${b.bracket}) seed=${seed} ===`);
console.log(`status=${res.status} turns=${g.turn} winner=${g.result ? (g.result.humanWon ? 'P0 ' + a.name : 'P1 ' + b.name) : '-'} reason=${g.result?.info?.reason || '-'} (${ms}ms)`);
console.log(`life: ${g.players.map((p) => p.name + ' ' + p.life).join(' | ')}`);
console.log(`scores: ${(g.scores || []).map((s, i) => `${g.players[i].name}=${s.total}`).join(' | ')}`);
console.log(`combos: ${g.comboHistory.map((c) => c.name).join(', ') || 'none'}`);
console.log(`unsupported ops: ${[...g.unsupported].join(', ') || 'none'}`);
console.log(`board: ${g.players.map((p, i) => `${p.name}: ${g.controlledBy(i).length} perms, hand ${p.zones.hand.length}, lib ${p.zones.library.length}`).join(' | ')}`);
console.log('--- last 25 log lines ---');
console.log(g.logLines.slice(-25).map((l) => `T${l.turn} ${l.text}`).join('\n'));
if (res.status === 'stalled') { console.log('STALLED at', g.step, 'player', g.priority); }
