# Sources, and why the design is shaped the way it is

Three external things drive decisions in this codebase. Anything that had to be worked around is stated plainly, because two of them are "no".

## 1. Card data — Scryfall

* `https://api.scryfall.com/bulk-data` → the `oracle_cards` bulk file. `scripts/fetch-oracle.mjs` pulls it, keeps the 462 cards the pool needs, and writes `src/data/oracle.json` (name, mana cost, type line, oracle text, P/T, colour identity, keywords, and a `legalities` check).
* Game Changers come from the live search `https://api.scryfall.com/cards/search?q=is%3Agamechanger`. 53 cards as of the 2026-02-09 update. This is the reason the validator exists: hand-maintaining that list went stale, so `src/data/gamechangers.json` is regenerated rather than typed.
* Scryfall asks for ~10 req/s and a custom `User-Agent`, and their docs prefer bulk data over per-card calls. `fetch-oracle.mjs` does one bulk download per run and a single search for Game Changers, with delays between requests.
* Scryfall's terms: card text and images remain Wizards of the Coast property; Scryfall's own data is offered for non-commercial fan use with attribution. **This app stores no card images at all** — the board is rendered from data (name, cost, P/T, type line), which keeps the whole thing light, offline-capable, and clear of image licensing. Attribution lives in the footer of `public/index.html`.

## 2. Commander Brackets

* Wizards announcement: `https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta`, plus the current state as described by the community trackers (scrollvault, mtgedh) confirming the system is still running as announced in 2026.

| Bracket | Name | Game Changers | Mass land denial | Extra turns | 2-card combos | Expected length |
|---|---|---|---|---|---|---|
| 1 | Exhibition | 0 | no | **no** | **no** | 9+ turns |
| 2 | Core | 0 | no | yes | no (no chaining) | 8+ turns |
| 3 | Upgraded | ≤ 3 | no | yes | not before turn 6 | 6+ turns |
| 4 | Optimized | unlimited | yes | yes | yes | 4+ turns |
| 5 | cEDH | unlimited | yes | yes | yes | any |

Everything in that table is enforced in `src/decks/index.js` (`profileDeck`), and `tests/engine.test.mjs` asserts against the ten shipped decks. The bracket is also used for gameplay, not just validation: opening length before the handover (4/4/3/3/2 turns) and the expected game length in the scoring formula both come from it.

**Consequence you should know about:** bracket 1 banning 2-card combos means the Squirrel Swarm list had to lose `Ivy Lane Denizen` + `Scurry Oak` (a 2-card infinite with Chatterfang), and bracket 1 banning extra turns removed the extra-combat effect from it. The lists are built to be *legal in their bracket*, which is the whole point of the pitch: "both decks from the same bracket" has to mean something.

Game Changers counts across the pool: Squirrel Swarm 0, The Deep End 0, Kemba's Pride 0, Everything Burns 0, Death Is a Resource 2, The Land Reaches Back 1, Ninjutsu Tempo 6, No Humans Allowed 0, Storm Logic 21, One Combat Is Enough 8 — which is why Storm Logic and One Combat Is Enough are the B5 pair.

## 3. The daily-puzzle model — Daily Red

* Coverage of Daily Red (dexerto, polygon, heldgames, and `dailyred.online` / `daily-red.com`) established the pattern this site copies: **one seeded scenario for everyone, one official attempt**, a battle that resumes exactly where you left it if you close the tab, unlimited practice that never touches the record, no spoilers until you're done.
* The reset-at-1am-American-Eastern clock, the server-side run record, and the "you already played today, here's your result" state all come from that model. What is invented here is the handover (bot plays the opening, you inherit a live board) and the points-for-quality-of-play idea, which is the part that makes a Commander game scoreable at all.

## 4. Deck sources — what was rejected

* **Moxfield** (`moxfield.com/decks/public`) — **cannot be used.** Their FAQ states the API is private; `api2.moxfield.com` returns Cloudflare 403 to non-browser clients; their terms prohibit automated requests. Harvesting public decks was abandoned deliberately rather than worked around. `moxfield.com` also has no published bulk export endpoint.
* **Archidekt** — their undocumented JSON endpoints (`GET /api/decks/v3/?page=n`, `GET /api/decks/<id>/`) respond without credentials and their terms allow personal non-commercial use, but **prohibit automated querying**. Viable only for a single deck a *user* asks for, one request at a time with caching — which is exactly the shape of `/api/import`. It was not used as a background harvester.
* **EDHREC / MTGGoldfish / Archidekt top-decks** — editorial content, no licence for redistribution; used only for guidance on what a bracket-3 Omnath or bracket-5 Godo list looks like when hand-building the ten seed decks.
* Net effect: the daily pool is ten hand-built, bracket-legal, Scryfall-validated lists, and real decks arrive through the paste-import path. This is a smaller pool than "random decks from Moxfield" would have been, and it is the honest version of that requirement.

## 5. Rules sources

* Comprehensive Rules — turn structure, priority, the stack, state-based actions, layer system, combat damage assignment, replacement effects. Implemented in `src/engine/game.js`, `driver.js`, `cards.js`. Section numbers are cited in comments at the places they matter (e.g. CR 117.3d/117.4 in `priorityWindow`, CR 510.1 in `combatDamage`, CR 704/903.10a in the win conditions).
* Commander rules — 40 starting life, colour identity, command zone, commander tax (+{2} per previous cast, CR 903.8), 21 commander damage (CR 903.10a). Tested.
* Where the rules are *not* implemented, it is documented rather than glossed — see the "Rules fidelity" section of `README.md`, which is mirrored in the in-app info panel so a player reading it is never misled about what the engine is doing.
