# Commander Daily

A daily Commander (EDH) puzzle in the shape of Daily Red / Wordle: **one seeded matchup a day, the same opening for every player, one scored attempt, unlimited practice**. The bot plays both decks for the opening turns, then hands you one of them at a pivotal moment.

```
npm start             # http://localhost:3000
npm test              # 83 tests: bracket legality, the 1am ET clock, restart safety, rules, scoring,
                      #   paying a "sacrifice a creature" cost, zone layout, the upload gate, moderation.
                      #   Writes to a throwaway store.
npm run sweep         # 45 days played out (with and without a vote winner) plus practice rounds
npm run sim           # bot-vs-bot every same-bracket pairing; reports crashes, stalls, game length
npm run coverage      # card-automation coverage report -> src/data/coverage.json
npm run fetch-cards   # re-pull oracle data + the live Game Changers list from Scryfall
node scripts/deploy-smoke.mjs <url> phase1|phase2   # proves a deployed daily survives a restart
node scripts/check-kv.mjs <rest-url> <token>       # proves an Upstash/REST store works before you deploy
node scripts/fake-upstash.mjs                      # local stand-in for that REST store, for rehearsing deploys
```

Node 20+, no runtime dependencies. Data lives in `data/store.json`, or in a Redis-KV if you set
`STORE_BACKEND=upstash` — which is what free hosts with no disk need. **See [DEPLOY.md](DEPLOY.md) for
the free public hosting recipe (Render + Upstash, or an Oracle Always Free VM).**

---

## What's actually built

| Requirement | Where | Notes |
|---|---|---|
| Deployable to a free host, publicly | `src/server/store.js`, `Dockerfile`, `render.yaml` | The store is pluggable: a JSON file, or a Redis-REST KV for hosts that wipe their disk (Render free, Fly trial). State survives redeploys — proven by `scripts/deploy-smoke.mjs`. Rate limiting (per session *and* per IP), a 256 KB body cap, `/healthz`, graceful `SIGTERM` flush, and start-up pruning of stale runs are all in place. |
| Same starting point for every player, daily | `src/server/daily.js` | Day key rolls at **01:00 America/New_York** (DST-aware). Seed = hash of the day key, so decks, shuffles, opening hands and the scripted opening are byte-identical for everyone. |
| One attempt a day, reload-proof | `src/server/store.js`, `src/server/server.js` | The run lives server-side under a signed session cookie. Reloading resumes the same board, hand and life totals **with the RNG restored mid-stream** — you cannot reroll an opening. |
| Bot plays both decks, you take over | `src/engine/driver.js` (`stopWhen`) | Opening length scales with bracket (4 turns for B1–B2, 3 for B3, 2 for B4–B5); you take the seat on your next turn. |
| Full rules understanding | `src/engine/*` | Turn structure, priority, stack, state-based actions, layer system, combat, commander rules (colour identity, command zone, tax, 21 commander damage), automatic mana payment. Coverage is measured, not claimed — see below. |
| Cards apply their own effects & interactions | `src/engine/scripts.js`, `compiler.js` | Two-tier: hand-written scripts for commanders, combo pieces and unusual text; an oracle-text compiler for everything else. Every card in the pool is automatic; **91% fully automated** with the remainder partially done and *reported in-app*. |
| Practice mode, separate + randomised | `POST /api/practice/start` | Random bracket, random pair, **excludes both of today's decks**, unlimited, never touches the leaderboard. |
| Clear winner | `src/engine/game.js` (CR 704 / 903.10a) | Life ≤ 0, 21 commander damage, library out, or concession. |
| Points + live feedback | `src/engine/score.js` | Awards read out plainly mid-game: *"Great combo!"*, *"Answer! Countered Rhystic Study"*, *"Saved your Kemba!"*, *"Big hit — 6 damage through"*. Panel sits beside the board in both modes. |
| Combo visual effect | `public/app.js` (`fxCombo`) | Every card in the combo gets a **"Combo!"** badge for 3 seconds plus a screen flash and sparks. |
| Play effect | `public/style.css` (`playIn`) | Cards land with a scale/rotate pop; damage flashes, life totals punch, points float up. |
| Pick the creature you sacrifice | `game.js` (`sacrificeChoicesFor`), `startSacrificePick()` | A cost that reads *"Sacrifice a creature"* is a real choice (CR 601.2h): the sheet lists it as an option, the legal creatures glow, and the engine validates the victim **before** paying anything else. Activate without naming one — as the bot does — and the cheapest creature pays. *"Sacrifice another creature"* never offers the source itself. |
| Opponent-themed UI, changes daily | `applyTheme()` | The palette is derived from the bot deck's theme colour; today it is *Funeral Violet* because the opponent is Teysa Karlov. |
| Drag & drop, mobile-friendly | `public/app.js` (pointer events) | **Drag a card onto the table** to play it — the deliberate fast path — or **tap it to see everything it can legally do**. Targeting highlights legal targets; attackers/blockers are tap-to-select. The whole game fits one screen at 1440×900, 1280×720 and 390×844 (measured, see below). |
| Every legal option, in plain words | `optionsFor()`, `openCardMenu()` | Tapping a card opens a sheet listing each legal thing separately — *Play Mountain*, *Cast Krenko, Mob Boss*, *Equip Skullclamp* — one row each, with its cost and what it will ask for (target, sacrifice). There is no such thing as a tap that silently commits a play. |
| The whole table on one screen | `public/style.css` ("THE TABLE") | Your board, the opponent's board, the opponent's hand, the action dock, the log and the reset clock all fit the viewport with **no page scrolling** at any of the three sizes above. A permanent row overlaps its cards by 18px and scrolls sideways instead of wrapping, so a wide board never pushes the hand off the bottom. |
| A log that says one thing once | `renderLog()`, `playNewEvents()` | Playing a land is a 2-second toast (*"You play Swamp"*) and one quiet log line — there is no second *"enters the battlefield"* line for the same event. Casting a permanent logs the cast, not the resolution. Tokens are never announced as cards. |
| Leaderboard + name popup | `POST /api/submit` | Fires once the run ends; scores ranked by points, then turns. |
| Readable cards, one action bar | `public/app.js`, `src/server/server.js` | Hand and battlefield cards carry artwork and their printed rules text (the view reads the card through to its oracle record). Everything pressable — plays, abilities, pass, combat, target picking — renders in one dock between the two boards instead of the sidebar. |
| Report a card that misbehaved | `POST /api/report-card`, `src/engine/corrections.js` | The engine answers the report itself: printed text vs. compiled script. Mechanical gaps are corrected automatically, saved, and applied to every later game; anything else is recorded with the reason. `GET /api/reports?token=$ADMIN_TOKEN` lists them. |
| Vote for tomorrow's deck | `daily.voteOptions`, `tallyVotes` | Three deterministic candidates plus "surprise me". A clear winner seeds tomorrow's matchup; ties and "random" fall back to the seeded pick. |

## Points, concretely

`src/engine/score.js` is the only place points come from — the client can't award them.

* **Interaction** — removal on real threats, countering opponent spells of mana value ≥ 3, big hits getting through.
* **Protection** — saving your permanents (indestructible, regeneration, redirects).
* **Combo** — declared combo lines fire from `COMBO_REGISTRY`: Godo + Helm of the Host, Kiki-Jiki + Conscripts, Oracle + Consultation/Pact, Breach + LED, Sanguine Bond + lifelink, Doubling Season explosions.
* **Efficiency (settled at game end)** — winning fast is worth more (`10 + 2 × turns under the bracket's expected length`); losing still pays for how long you lasted, how close you came, and how much damage you dealt. Losing is not worth zero, which matters for a puzzle where you can't replay.

## Decks: two per bracket, validated, not scraped

`src/decks/lists.js` holds ten real 100-card lists (Chatterfang, Arixmethes, Kemba, Torbran, Teysa, Omnath, Yuriko, Winota, Kess, Godo), two per official bracket. `scripts/fetch-oracle.mjs` validates every one against live Scryfall data and refuses to let a bad list through. It caught real problems while building this:

* `Dockside Extortionist` is **banned** in Commander — removed from the Godo list.
* `Prophet of Kruphix` is banned — replaced.
* `Seedborn Muse` is a **Game Changer** — illegal in a Bracket 1 deck, caught by the bracket profiler.
* Two cat cards were off-colour for a mono-white commander.
* `Ivy Lane Denizen` + `Scurry Oak` is a 2-card infinite — banned in Bracket 1, swap issued.

Bracket rules are enforced in code (`bracket.js` logic in `src/decks/index.js`): B1/B2 = 0 Game Changers, B3 ≤ 3, no mass land denial below B4, no extra turns in B1, no 2-card combos below B4, with the Game Changers list read live from Scryfall `is:gamechanger` (53 cards as of the Feb 2026 update).

**On Moxfield:** `moxfield.com/decks/public` can't be used as a source. Moxfield has no public API (their FAQ says the API is private), their endpoints Cloudflare-403 non-browser clients, and their terms prohibit automated requests. So the pool is curated, and real decks come in through a working import endpoint instead:

```bash
curl -X POST localhost:3000/api/import -H 'content-type: application/json' \
  -d '{"text":"Commander: Krenko, Mob Boss\n1 Krenko, Mob Boss\n32 Mountain\n1 Skullclamp\n..."}'
```

`src/server/importDeck.js` parses Moxfield/Archidekt/MTGO/Arena exports (counts, `1x`, `(SET) 123` lines, `Commander:` lines or `// Commander` sections), resolves cards against the local oracle data, auto-estimates the bracket from Game Changers + detected combos, flags off-colour cards, and hands back a playable deck with `fromProviderDeck()` as the adapter for a licensed or partner API. Paste a complete 100 and it can be added to the daily pool.

## Rules fidelity — what is and isn't implemented

Implemented: turn structure and steps, priority and the stack, state-based actions (lethal damage, 0 toughness, life ≤ 0, legend rule, aura/equipment fall-off, +1/+1 and −1/−1 counters annihilating), the layer system for P/T and ability-adding effects, combat with first/double strike, trample, deathtouch, lifelink, infect; commander colour identity, command-zone returns, tax and 21 commander damage; automatic land/rock tapping including duals, any-colour sources, cost reducers and damage modifiers.

Deliberately not implemented (listed in-app too, so nobody is misled):

* Full CR 614/616 replacement-effect ordering (self-replacement, applying order choices).
* CR 613 dependency loops between continuous effects.
* Copying spells on the stack (permanent copies work).
* Alternate/additional costs beyond commander tax — kicker, flashback, escape, delve, mutate, companion.
* Multiplayer: this is 1v1 Commander with 40 life; no politics, no turn order beyond two players.
* Combat damage assignment among multiple blockers is auto-assigned by the engine.

## Card coverage

`npm run coverage` walks all 462 unique cards in the pool and reports:

| Status | Count | Meaning |
|---|---|---|
| scripted | 315 (68%) | Hand-written behaviour (commanders, ramp, removal, combo pieces, equipment, token engines) |
| vanilla | 62 (13%) | Creatures/scenes with nothing to automate beyond keywords |
| compiled | 59 (13%) | Auto-derived from oracle text (draw, damage, destroy, pump, tokens, scry, counterspells) |
| partial | 26 (6%) | Some clauses not automated — **listed in the app** under ⓘ |

Fully automated: **91%** (419 of 462 cards: 315 hand-written scripts, 70 compiled, 34 vanilla; 34 partial, 9 unhandled). The honest gap is mostly big "if you paid the kicker / cast it from your hand" modal effects, devotion counts, and spell-copying. The engine never fails silently: unhandled ops land in `game.unsupported` and are surfaced in the UI instead of pretending.

## Architecture

```
src/decks/      deck lists, 100-card normalisation, bracket profiling
src/data/       oracle.json + gamechangers.json from Scryfall, coverage/validation reports
src/engine/
  cards.js      card parsing, instances, layer system (CR 613)
  ops.js        effect primitives + targeting + the effect executor
  compiler.js   oracle text -> effect steps (conservative; unparsed text is recorded)
  scripts.js    hand-written card behaviour + combo registry
  targeting.js  target requirements + bot target heuristics
  game.js       turn structure, priority, stack, SBAs, casting, mana payment, commander rules
  driver.js     the engine loop: steps, priority windows, combat, handover
  bot.js        bot policy (aggro / midrange / control / combo)
  score.js      points, awards, end-of-game settlement
src/server/
  store.js      persistence: JSON file or Redis-REST KV, debounced + retried writes
  daily.js      day clock (01:00 ET), pairing, bracket rotation, votes
  server.js     HTTP API, session cookies, rate limits, static client
  importDeck.js pasted-decklist importer (Moxfield/Archidekt/MTGO/Arena exports)
public/         index.html, style.css, app.js — no framework, no CDN, works offline
```

## Testing and simulation

`npm test` — 83 tests, including: all ten decks are exactly 100 cards / legal / bracket-clean; the day key rolls at 01:00 ET in both EST and EDT; identical seeds produce an identical opening board; a revived run continues instead of rerolling; trample assigns exactly lethal then spills; deathtouch + lifelink behave; commander tax is +{2} per prior cast; 21 commander damage ends the game; a mono-white board can't pay for a double-black cost; combos award points; wins and losses settle differently; a full bot-vs-bot game always terminates; a *"sacrifice a creature"* cost offers every creature you control and kills the one you named (and refuses one you don't); the bot feeds the cheapest one; *"sacrifice another creature"* never offers the source; **and a run that is packed into storage, serialized and revived before every single action still ends up in exactly the same state** — the regression guard for "it only breaks after a redeploy".

`npm run sim` — 15 same-bracket pairings, all finishing, zero crashes/stalls, averaging ~20 turns.

### The board, the tabs, and the rotation

- **Three labelled zones per player.** `creatures → permanents → lands`, front to back, with the two
  creature rows meeting at the middle of the table (`#combatLine`). The hand is *not* on the battlefield:
  it is its own raised, accent-lit panel with a live count, and playable cards are ringed and tagged.
- **Three lobby tabs.** *Daily* (today's matchup, standings, the pool), *Practice* (unlimited rounds that
  never touch the record), *Tools* (vote for tomorrow, engine stats, upload a deck, browse the community
  rotation).
- **The rotation freezes at the reset.** A deck uploaded at lunchtime is playable in practice immediately
  and joins the daily from the *next* 01:00 ET reset. Without that freeze, someone uploading a deck would
  change the day out from under everyone who had not started yet — the day has to be the same puzzle for
  everybody. Uploads are identified by a fingerprint of their 100 cards, so re-submitting the same list
  updates one slot instead of padding the pool with twins.
- **Moderation.** Deck names and lists are public, so set `ADMIN_TOKEN` and
  `POST /api/community/remove {"id": "…", "token": "…"}` takes a deck out of the rotation. With no
  `ADMIN_TOKEN` set the endpoint refuses to act at all.
- **The action dock.** Everything a player can press lives in one bar in the middle of the table —
  playable cards, activated abilities, *Pass priority*, and the combat/target prompts — instead of
  sitting in the sidebar. The dock is in the flow of the table, so a decision is never something you
  scroll to find, and it wraps its own options rather than running off the edge.
- **The hand is a hand.** Your cards are fanned along the front of the table, each one clear of the
  next to the point where its name, type line, cost and rules text stay readable; run out of width and
  the fan scrolls sideways, centred, so the cut falls on the two outer cards. Nothing is ever drawn on
  top of a card's art or text.
- **The rail on a phone.** At ≤1000px the sidebar becomes a single-column strip under the table —
  clock, points, match state, log, concede — instead of a sheet that has to be opened.
- **Cards read like cards.** Hand and battlefield cards show artwork plus the full rules text
  (reminder text in brackets is dropped first). An action that will ask for a target carries a
  `target` tag on its chip, and choosing it turns the dock into the target picker with the legal
  choices glowing on the table.
- **Report a card.** Tap any card → *⚑ This card misbehaved* → a report. The server answers it from
  the engine's own picture of the card: printed text versus compiled script. Where the gap is
  mechanical — a spell whose text targets and which was never asked for a target — the fix is derived
  automatically, stored, applied from the next game onward and *kept across restarts*
  (`src/engine/corrections.js`). Where the gap needs a hand-written fix, the report says so honestly
  instead of pretending. `GET /api/reports?token=$ADMIN_TOKEN` lists reports and live corrections.


`npm run sweep` — the round-trip gate: 45 days of the daily, each played **twice** (once with a vote
winner taking a seat, once without), plus three practice rounds per day. For every day it checks that the
matchup is deterministic, brackets match, no deck plays itself, the vote winner actually reaches the
table, the game ends with a winner and points awarded, and a reload (pack → revive) partway through does
not change the result. It also enforces the invariant that no commander is ever left in a hand or a
library — the failure that made 2026-01-17 unwinnable. Last run: 90 games, 135 practice rounds, 0 problems. Use it before adding decks: it is the fastest way to catch a card script that throws.

### Cards that were quietly doing nothing

Every trigger in the pool is written against an event name, and the engine emits events by name. Get one
letter wrong — `permanentDied` here, `permanentDies` there — and the card compiles perfectly, reports as
*fully automated*, sits in a seed deck, and does nothing at all for the whole game. Nothing in a normal
test suite catches that, because nothing throws.

The audit found four such mismatches, one dead flag, one duplicated script key and one impossible
condition, all in cards from the ten seed decks:

| Card | What was wrong | Now |
|---|---|---|
| Sanguine Bond | the engine never emitted `youGainLife` at all (only a zero-amount stub), and the drain was hardcoded to 1 | you gain 4, they lose 4 |
| Yahenni, Undying Partisan | two scripts under the same key — the later one won, so the death trigger never existed | one script, both halves |
| Beastmaster Ascension | the `questCounters` flag nothing read; the static was unreachable | attacking creatures add quest counters, seven of them is +5/+5 |
| Moldervine Reclamation | the clause parser read "you gain 1 life" and dropped "and draw a card" | gain 1, draw 1 |
| Umezawa's Jitte | nothing emitted `dealsDamage`, and the cost was written `removeCounters`, which the engine never understood | charge counters on damage, and all three modes are activatable |
| Boros Reckoner | nothing emitted `selfDamaged` ("that much damage" needs the number the trigger fired with) | it throws the damage back, at the best target for its controller |
| Terastodon | the script destroyed one opponent artifact; the printed text is three noncreature permanents and an Elephant each | as printed |
| every Equipment with `Equip {2}`+ | the equip gate asked whether the *Equipment* was a creature, so only free equips worked | all of them equip |

`no card waits for an event the engine never emits` is now a test: it reads the engine's own source for
`type: '…'` emit sites, compiles all 462 cards, and fails if any trigger names an event that is never
emitted. That is the guard, not the fixes.

### Rules details worth knowing

- **Auras.** An Aura's target comes from its own `Enchant …` line (CR 303.4a), it enters attached to
  what it was cast on, its continuous effects and granted abilities belong to the enchanted permanent,
  and a state-based action puts it into the graveyard when its host leaves (CR 704.5m). Casting one
  without a legal target is refused (CR 601.2c) — the visible bug that started all of this was a
  Pacifism landing on the battlefield attached to nothing.
- **Targets on the stack.** A spell on the stack is a legal target for a counterspell; the target
  list survives resolution so the counterspell actually counters something.
- **Restrictions.** "Can't attack" / "can't block" are compiled into keyword grants that the *single*
  place deciding combat legality reads, so Pacifism stops a creature from attacking and blocking.
- **"That much".** A trigger that says "that much" reads the number it fired with from the event the
  engine carries onto the stack with it (CR 603.2c) — that is how Sanguine Bond drains what you actually
  gained and Boros Reckoner throws back what it actually took.
- **Endless loops.** Two effects that feed each other (a token that dies into a token that dies) would
  spin the priority loop until the process died. The engine counts resolutions per step and calls an
  unbreakable cycle a draw (CR 104.4b) with a line in the log. Requiem Angel also no longer triggers
  off its own Spirits — the loop that found this.

## Known gaps / next steps

1. **Manual mana and X costs.** Mana is auto-tapped with a solver; X spells pick a sensible X automatically. A tap-land-for-mana UI and an X slider are the next quality-of-life items.
2. **Practice runs are in-memory**, so a server restart drops them mid-game (the *daily* is persisted and survives restarts, including on hosts with no disk).
3. **Scry/surveil are deterministic smoothing** rather than true library ordering.
4. **Deck pool size.** Ten decks means the daily rotation repeats every few weeks; the pool is designed to grow through the import hook.
5. **Multiplayer Commander** — 4-player pods with politics would be the natural next iteration, and the engine is structured for it (APNAP ordering, per-player damage tracking).

## Deploying

`DEPLOY.md` covers it end to end: the Render + Upstash free path (with the `render.yaml` blueprint), the Oracle Always Free VM path with systemd and Caddy, a Docker one-liner, and a pre-launch checklist. The one thing not to skip: **set `SESSION_SECRET`**, or every restart invalidates every session and players lose their in-progress daily.
