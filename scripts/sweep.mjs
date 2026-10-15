/**
 * The day sweep: 45 days of the rotation, each with and without a vote winner,
 * plus practice rounds — every configuration actually played out by the engine.
 *
 *   npm run sweep            (45 days)
 *   npm run sweep -- 120     (more days)
 *
 * Checks, per day:
 *   - the matchup is deterministic (same day key → same decks, seed and seat)
 *   - both decks are from the same bracket, and they are different decks
 *   - the human is not handed a deck it is also playing against
 *   - the game finishes with a declared winner, no stalls and no crashes
 *   - practice never uses either of that day's decks, and re-randomises
 *   - a run survives being packed to JSON and revived mid-game (what a reload does)
 */
import { dailySetup, practiceSetup, voteOptions, dayKeyFor, previousDayKey, rotationPool } from '../src/server/daily.js';
import { createGame, packGame, reviveGame } from '../src/engine/game.js';
import { runEngine, playOpening, applyPlayerAction } from '../src/engine/driver.js';
import { makeBot } from '../src/engine/bot.js';
import * as store from '../src/server/store.js';

const days = Number(process.argv[2] || 45);
const start = new Date(Date.UTC(2026, 0, 1));
const problems = [];
const fail = (what) => { problems.push(what); if (problems.length <= 12) console.log(`  FAIL ${what}`); };

let games = 0;
let served = 0;
let totalTurns = 0;
let forfeits = 0;
const rejections = [];
const allPoints = [];
let wins = 0;
let losses = 0;

for (let i = 0; i < days; i++) {
  const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);

  for (const voted of [false, true]) {
    // The voted branch is exercised for real: cast ballots the day before and
    // check the winner actually takes a seat (rather than re-reading the same
    // no-vote setup and calling it covered).
    let expectedVote = null;
    if (voted) {
      const options = voteOptions(previousDayKey(day)).options;
      expectedVote = options[0].id;
      for (const voter of ['a', 'b', 'c']) store.castVote(previousDayKey(day), `sweep-${voter}`, expectedVote);
    }
    const setup = dailySetup(day);
    const again = dailySetup(day);
    const key = (s) => `${s.bracket}|${s.humanDeck.id}|${s.botDeck.id}|${s.seed}|${s.humanIsA}`;
    if (key(setup) !== key(again)) fail(`${day}: the daily is not deterministic`);
    if (setup.humanDeck.bracket !== setup.botDeck.bracket) fail(`${day}: brackets do not match`);
    if (setup.humanDeck.id === setup.botDeck.id) fail(`${day}: a deck is playing itself`);
    if (voted && expectedVote) {
      const seats = [setup.humanDeck.id, setup.botDeck.id];
      if (!seats.includes(expectedVote)) fail(`${day}: the vote winner (${expectedVote}) did not reach the table`);
    }

    // (a) Play the matchup out end to end, both seats driven by the engine.
    //     This is the "does the day's game actually resolve" check.
    try {
      const g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
      g.bot = makeBot(setup.decks[1].prototype);
      const res = runEngine(g, { stopForHuman: false, maxIterations: 30000 });
      games++;
      if (res.status !== 'over' || g.status !== 'over') fail(`${day}${voted ? ' (voted)' : ''}: ended as "${g.status}" without a winner`);
      else {
        totalTurns += g.turn;
        if (g.forfeit) forfeits++;
        JSON.stringify(packGame(g)); // the final state must still serialise (that is what a reload serves)
        const pts = g.scores?.[g.humanId]?.total || 0;
        if (pts <= 0) fail(`${day}: the human seat finished with ${pts} points`);
        allPoints.push(pts);
        if (g.result?.humanWon) wins++; else losses++;
      }
    } catch (e) {
      fail(`${day}${voted ? ' (voted)' : ''}: crashed — ${e.message}`);
    }

    // (b) The takeover path, exactly as a player experiences it: the bot opens the
    //     game, then every decision offered to the human is taken — including a
    //     reload (pack → revive) partway through, which is what refreshing does.
    try {
      let g = createGame({ decks: setup.decks, seed: setup.seed, options: { humanIsBot: true } });
      g.bot = makeBot(setup.decks[1].prototype);
      playOpening(g);
      let steps = 0;
      while (g.status !== 'over' && steps++ < 6000) {
        const pending = g.pending;
        if (!pending) break;
        if (pending.type === 'priority') {
          const real = (pending.actions || []).filter((a) => a.type !== 'pass');
          if (!real.length) { fail(`${day}: offered a priority window with nothing but "pass"`); break; }
        }
        const action = pick(g, pending);
        if (!action) break;
        if (steps % 25 === 0) g = reviveGame(JSON.parse(JSON.stringify(packGame(g))));
        const out = applyPlayerAction(g, g.humanId, action, { bot: g.bot });
        if (out.error && action.type !== 'pass') rejections.push(`${day}: ${action.type} — ${out.error}`);
        runEngine(g, { stopForHuman: true });
      }
      if (steps >= 6000) fail(`${day}: the takeover game never finished`);
      else if (g.status !== 'over') fail(`${day}: the takeover game ended as "${g.status}"`);
      JSON.stringify(packGame(g));
    } catch (e) {
      fail(`${day}: the takeover path crashed — ${e.message}`);
    }
  }

  // Practice: unlimited, re-randomised, and never today's decks.
  const today = dayKeyFor(new Date(`${day}T18:00:00Z`));
  const daySetup = dailySetup(today);
  for (const seed of [1, 2, 3]) {
    const prac = practiceSetup(seed, [daySetup.humanDeck.id, daySetup.botDeck.id]);
    if ([daySetup.humanDeck.id, daySetup.botDeck.id].includes(prac.humanDeck.id)
      || [daySetup.humanDeck.id, daySetup.botDeck.id].includes(prac.botDeck.id)) {
      fail(`${day}: practice used one of the daily decks`);
    }
    if (prac.humanDeck.id === prac.botDeck.id) fail(`${day}: practice paired a deck with itself`);
    if (prac.humanDeck.bracket !== prac.botDeck.bracket) fail(`${day}: practice brackets do not match`);
    served++;
  }
}

// The pool itself: every deck in it must be buildable and legal for its bracket.
const pool = rotationPool();
const ids = pool.map((d) => d.id);
if (new Set(ids).size !== ids.length) fail(`the pool has duplicate ids (${ids.length - new Set(ids).size})`);
for (const d of pool) {
  if (!d.cardList || d.cardList.length !== 100) fail(`pool deck ${d.id} is not a 100-card deck`);
  if (d.bracket < 1 || d.bracket > 5) fail(`pool deck ${d.id} has bracket ${d.bracket}`);
}

const avg = games ? (totalTurns / games).toFixed(1) : '0';
if (rejections.length) {
  console.log(`\n${rejections.length} action(s) the engine refused:`);
  for (const r of rejections.slice(0, 5)) console.log(`  ${r}`);
}
const minPts = allPoints.length ? Math.min(...allPoints) : 0;
const maxPts = allPoints.length ? Math.max(...allPoints) : 0;
console.log(`\n${games} daily games over ${days} days | ${served} practice rounds | avg ${avg} turns | forfeits ${forfeits}`);
console.log(`human seat: ${wins} wins / ${losses} losses | points ${minPts}–${maxPts}`);
console.log(problems.length ? `${problems.length} PROBLEM(S)` : 'sweep clean: 0 problems');
process.exit(problems.length ? 1 : 0);

/**
 * The action a stand-in takes in the player's seat. Priority windows are decided
 * by the bot's own chooser — picking "the first action that is not pass" looks
 * reasonable but loops forever on mana abilities, which are legal to activate
 * any number of times.
 */
function pick(game, pending) {
  switch (pending.type) {
    case 'priority': {
      const chosen = game.bot.chooseAction(game, game.humanId);
      return chosen?.action || { type: 'pass' };
    }
    case 'declareAttackers': return { type: 'attackers', iids: pending.suggested || [] };
    case 'declareBlockers': return { type: 'blockers', pairs: pending.suggested || [] };
    case 'mulligan': return { type: 'keep' };
    default: return pending.actions ? pending.actions[0] : null;
  }
}
