# Deploying Commander Daily for free, publicly

Short answer: **Render's free web service + a free Upstash Redis for the store.** That combination is genuinely $0, needs no credit card, and — importantly for this app — survives restarts. If you'd rather have an always-on box with no cold starts, **Oracle Cloud's Always Free Arm VM** is the other real option. Both are wired up below, and both have been verified against this codebase's restart test.

There's one non-obvious thing that decides everything, so it goes first.

---

## 1. The thing that decides everything: the store

Commander Daily's promise is *"one attempt a day, resume exactly where you left off."* That promise lives in a single JSON document (`data/store.json`): every in-progress run, the leaderboard, the votes, the sessions.

**Free app hosts have no disk.** Render's docs say it plainly: a free web service "cannot attach a persistent disk", and local filesystem changes are lost on every spin-down, restart and redeploy. Fly's trial and most serverless hosts behave the same way. On those hosts, the moment the service sleeps — 15 minutes with no traffic — every player's daily run and the whole leaderboard are gone.

So the store is now pluggable (`src/server/store.js`):

| `STORE_BACKEND` | Where the data lives | Use it when |
|---|---|---|
| `file` (default) | `data/store.json`, atomic writes | Local dev, a VPS, or any host with a real disk |
| `upstash` | Your Redis store over HTTPS REST (`KV_REST_API_URL` + `KV_REST_API_TOKEN`) | Any host with an ephemeral filesystem |

The settings that matter:

```bash
STORE_BACKEND=upstash
KV_REST_API_URL=https://us1-xxxx.upstash.io
KV_REST_API_TOKEN=AXxxxx...
STORE_KEY=commander-daily:store:v1   # optional
STORE_FLUSH_MS=1500                  # optional: write debounce
```

Writes are debounced and flushed; a failed flush stays dirty and retries; `SIGTERM` flushes before exit (`Render` sends `SIGTERM` on spin-down, so the last few seconds of play are not lost). Old run snapshots are pruned at boot — only today's and yesterday's are kept — so the document stays small on a 256 MB free tier.

**This is verified, not asserted.** The repo ships a two-phase restart test:

```bash
node scripts/deploy-smoke.mjs https://your-app.onrender.com phase1
# ...let it sleep, or redeploy, or kill the process...
node scripts/deploy-smoke.mjs https://your-app.onrender.com phase2
```

Phase 2 fails loudly if the board, hand, life totals or turn differ from where phase 1 left off. Against a KV-backed instance whose local disk I wiped between phases it prints:

```
PHASE 2 — resumed: true
  before restart: {"turn":7,"status":"playing","myLife":40,"oppLife":40,"hand":3,"bf":12,...}
  after  restart: {"turn":7,"status":"playing","myLife":40,"oppLife":40,"hand":3,"bf":12,...}
  ✓ identical state — the daily survived the restart
  finished: over | points: 19
  leaderboard entry: #1 DeploySmoke 19pts won=true
```

---

## 2. Option A — Render free + Upstash free (recommended)

**Cost: $0.** No credit card needed for either. Two dashboards, ~10 minutes.

### Step 1 — the store

1. Sign up at [upstash.com](https://upstash.com) (free, no card), create a **Redis** database in the region closest to your Render region (e.g. us-east-1 ↔ Ohio/Virginia).
2. Copy the two REST values — the **Endpoint** (an `https://…upstash.io` URL) and the **Token** under the database's **REST API** section, or **Connect → REST** / **Connect → .env**. There is **no username, password or port** in this pair: if a panel shows you `rediss://default:PASSWORD@host:6379`, that's the TCP view and it's the wrong one. Also make sure the **Read-Only Token** switch is off, or writes will fail.
3. Check them before deploying:

```bash
node scripts/check-kv.mjs https://xxx.upstash.io <token>   # PING + SET/GET/DEL round trip
```

`SETUP.md` §Step 1 has the full walkthrough of this screen, including what each error means.

Free tier (checked 2026-10-15): **500,000 commands/month, 256 MB data, 10 GB bandwidth.** Each store write is a single `SET` of a debounced snapshot, so a busy day is a few hundred commands — call it ~10–15k/month for a few hundred daily players. You will not approach it.

### Step 2 — the app

1. Push this repo to GitHub (or GitLab/Bitbucket — see `SETUP.md` if connecting a Git host is being awkward).
2. Render → **New → Blueprint**, point it at the repo. `render.yaml` in the root does the rest: a free Node web service, `healthCheckPath: /healthz`, `SESSION_SECRET` auto-generated, `TRUST_PROXY=1`. It then **prompts for the two Upstash values** (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) — paste them from Step 1. It deliberately does *not* use Render's own free Key Value; see below.
3. If you'd rather click it manually: **New → Web Service**, runtime Node, build command *(leave empty — there are no dependencies)*, start command `node src/server/server.js`, health check `/healthz`, and add these env vars:

```
SESSION_SECRET   <generate 32 random bytes, e.g. openssl rand -hex 32>
STORE_BACKEND    upstash
KV_REST_API_URL  <from Upstash>
KV_REST_API_TOKEN <from Upstash>
TRUST_PROXY      1        # so per-IP rate limiting sees the real client
```

> **Do not skip `SESSION_SECRET`.** Without it the server generates a random one at every boot, which invalidates every cookie — every player's in-progress daily becomes unreachable after each restart.

4. Deploy, then verify:

```bash
curl https://your-app.onrender.com/healthz
# {"ok":true,"day":"2026-10-15","decks":10,"store":"upstash","dirty":false,...}
node scripts/deploy-smoke.mjs https://your-app.onrender.com phase1
```

### Why not Render's own free Key Value?

It looks like the obvious choice — it's in the same dashboard, and a Blueprint can wire it automatically. Don't: **Render's Free Key Value is in-memory only.** Render's docs: *"whenever an instance restarts, all of its data is lost"*, and *"Render might restart a Free Render Key Value instance at any time (thereby deleting its data)"*. That is exactly the failure this whole section exists to prevent — a restart would erase every player's in-progress daily and the entire leaderboard. (Paid Key Value instances do persist; the free ones don't.) There is a second, mechanical reason: the connection string is `redis://red-xxxx:6379` — a TCP Redis URL — while this app's store backend speaks Upstash's HTTPS REST API. Upstash's free tier is durable, so it's worth the second browser tab.

### What the free tier actually gives you

| | Free | What it means here |
|---|---|---|
| Instance hours | 750/month per workspace | 744 hours in a 31-day month — one always-on service just fits |
| Spin-down | after **15 min** with no traffic | First visitor waits 30–60 s for a cold start |
| RAM / CPU | 512 MB / 0.1 CPU | Fine: a whole Commander game is a few hundred KB of JSON |
| Disk | **none** (ephemeral) | Why the store must be external |
| Bandwidth | 5 GB/month | A full game is ~50–100 KB of API traffic |
| Build minutes | 500/month | This app has no build step at all |

**Kill the cold starts for free:** Render allows 750 instance hours, which covers a full month of continuous uptime for a *single* service. Point any free uptime pinger ([cron-job.org](https://cron-job.org), UptimeRobot, a GitHub Actions cron) at `/healthz` every 10–14 minutes and the service never sleeps — at $0, because 744 hours < 750. Keep to **one** free web service so you don't exceed the pool.

### Knobs worth setting

| Env var | Why |
|---|---|
| `TRUST_PROXY=1` | Behind Render's proxy, rate limits key on the real visitor IP instead of lumping everyone together |
| `ADMIN_TOKEN=<secret>` | Protects `/api/store-stats` (player counts) |
| `STORE_FLUSH_MS=5000` | Fewer Upstash commands, at most 5 s of play at risk on a hard kill |
| `MAX_BODY_BYTES=262144` | Default; caps request bodies so a huge POST can't OOM the 512 MB instance |

---

## 3. Option B — Oracle Cloud Always Free VM (always-on, no cold starts)

If "sleeps after 15 minutes" is unacceptable and you want a normal Linux box with a real disk, Oracle's Always Free tier is the most generous one that exists. It is also the most temperamental, so read the caveats.

**What you get (as of September 2026):** Arm Ampere A1 — **2 OCPU + 12 GB RAM** total (Oracle halved it from 4 OCPU/24 GB on 2026-06-15, enforced from ~2026-08-18), plus two AMD micro VMs (1/8 OCPU, 1 GB), 200 GB block storage, 10 TB/month outbound. No end date.

**Caveats, honestly:**

- **Capacity.** "Out of host capacity" is the single most common complaint; Always Free A1 exists only in your **home region**, which you cannot change later. Try a smaller/quieter region.
- **Idle reclamation.** Oracle may reclaim an instance that looks idle over 7 days (95th-percentile CPU < 20%, network < 20%, and on A1 memory < 20%). A small site is "idle" by that definition. A tiny cron that does real work periodically keeps you off that list.
- **Signup rejections** are common, and Oracle can change the allowances (it just did).

**Setup (Ubuntu, Arm):**

```bash
# on the instance
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
git clone <your repo> /opt/commander-daily && cd /opt/commander-daily

# the one secret you must set
sudo tee /etc/commander-daily.env >/dev/null <<'EOF'
SESSION_SECRET=REPLACE_WITH_openssl_rand_hex_32
PORT=3000
DATA_FILE=/var/lib/commander-daily/store.json
EOF
sudo chmod 600 /etc/commander-daily.env

sudo tee /etc/systemd/system/commander-daily.service >/dev/null <<'EOF'
[Unit]
Description=Commander Daily
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/opt/commander-daily
EnvironmentFile=/etc/commander-daily.env
ExecStart=/usr/bin/node src/server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now commander-daily
```

Then HTTP(S). Oracle images ship with strict `iptables`, so open the port **in both** the VCN security list and the OS firewall, and put TLS in front with Caddy (automatic Let's Encrypt):

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

On this path leave `STORE_BACKEND=file` and point `DATA_FILE` at the block volume. Back up by copying that one file — and set the same env var chain for `COOKIE_SECURE=1` if Caddy terminates TLS.

---

## 4. Option C — things that look free but aren't suitable

| Host | Why not |
|---|---|
| **Cloudflare Workers** | 100k requests/day looks great, but the free plan allows **10 ms of CPU per invocation** and terminates the request if you exceed it. A single turn of this engine is far past that. Would need Workers Paid + a rewrite. |
| **Render free Postgres** | Expires (30–90 days depending on which doc you read — either way it is not permanent). Upstash's KV has no expiry. |
| **Heroku / AWS / Azure free tiers** | Gone or time-limited. |
| **Vercel** | Serverless functions, same ephemeral + duration problem, plus the engine wants to hold process memory for practice games. |

What about **Fly.io**? Their trial works with `fly launch` + a volume, but it's a trial with a card on file, not a permanent free tier — fine if you already use them.

---

## 5. Self-hosting / anywhere with Docker

```bash
docker build -t commander-daily .
docker run -d --name commander-daily -p 3000:3000 \
  -v commander-daily-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e DATA_FILE=/data/store.json \
  --restart unless-stopped \
  commander-daily
```

The image is `node:20-alpine`, runs as the non-root `node` user, works on amd64 **and arm64** (so it runs on the Oracle Arm VM too), and has a `HEALTHCHECK` that hits `/healthz`. No dependencies to install — the whole app is ~450 KB of source.

---

## 6. Before you announce it publicly

Things I've already handled in the code, so you don't have to:

- ✅ **Rate limiting** — per session *and* per IP, plus a per-process ceiling. Without an IP key, a script that ignores cookies gets a fresh session per request and is never limited (that was a real hole; it's fixed). Import is capped much tighter than normal play.
- ✅ **Body cap** — request bodies over 256 KB are rejected with 413 instead of filling memory.
- ✅ **`/healthz`** — cheap readiness endpoint for pingers and platform health checks, no session or game state involved.
- ✅ **Graceful shutdown** — `SIGTERM` flushes the store before exit, so a spin-down or redeploy keeps the last few seconds of play.
- ✅ **Run pruning** — stale run snapshots are dropped at boot so the store can't grow unbounded on a free tier.
- ✅ **Wizards fan-content disclaimer** in the site footer. This matters: it's an unofficial fan project, and the page now says so, credits Scryfall for card data, and states it's free/non-commercial with no accounts.

Worth doing yourself:

- **Backups.** Copy the store document weekly: `GET` the `STORE_KEY` value from Upstash, or `cp data/store.json` on a VPS. It's one file; a shell one-liner in cron is enough.
- **Name moderation.** The leaderboard name is the only user-supplied text, it's capped and escaped on render, and there's no account system — but you may still want to trim what you don't want to publish. Keep a copy before you prune so you can restore.
- **One attempt per day is enforced server-side** per anonymous cookie. As with every cookie-based puzzle, a determined player can clear cookies — that's inherent to the "no accounts" design and worth knowing rather than pretending otherwise.
- **Announce timing.** The reset is 01:00 America/New_York; a new puzzle is guaranteed to exist at that moment, so that's the natural time to post.

---

## 7. Deploying updates

### How to tell whether you still need to (10 seconds)

```bash
cd ~/commander-daily
npm run check-live -- https://YOUR-APP.onrender.com
```

It compares `index.html`, `app.js` and `style.css` against this checkout byte for byte, checks that the
newer server endpoints answer, and reports whether the store is external. Exit code 0 means the site is
current; anything else is printed as a list of things to fix. Run it before you push and again after —
it is the same judgement call, without the guessing.

### Push it

The route depends on how the service was created (see Step 2 of `SETUP.md`):

| Service created from | How the update ships |
|---|---|
| A GitHub repo, linked through your account | commit to the default branch → Render redeploys by itself (`autoDeploy: true`) |
| **Public Git repository URL** ("skip GitHub" route 2C.2) | commit, then Render → **Manual Deploy → Deploy latest commit** — there is no auto-deploy on this route |
| An **existing Docker image** (route 2C.3) | rebuild and push the image, then **Manual Deploy → Deploy latest image** |

**Before you push, know this: your data is safe if (and only if) the store is external.** The live site
reports `"store":"upstash"` at `/healthz`, so runs, leaderboard and uploaded decks survive a redeploy.
On a local file store they would not — a deploy wipes the container's disk. Check with:

```bash
curl -s https://YOUR-APP.onrender.com/healthz
```

### Which files to upload

**Easiest and safest: upload the whole package.** Unzip `commander-daily.zip`, then in the GitHub web UI
use **Add file → Upload files** and drag in the *contents* of the folder (so paths like `src/server/`
come across, not a nested `commander-daily/` folder). Files with matching paths are replaced. One
commit, no chance of missing a file.

If you would rather push only what changed, this is the set — and **every "NEW" line matters**: the
server imports them at boot, and a missing module is a crash on deploy, not a silent degradation.

```
public/index.html          public/app.js            public/style.css
src/server/server.js       src/server/daily.js      src/server/store.js
src/server/verifyDeck.js   src/server/importDeck.js
src/engine/driver.js       src/engine/game.js       src/engine/ops.js
src/engine/scripts.js      src/engine/compiler.js   src/engine/targeting.js
src/engine/corrections.js  (NEW — the card-report overlay, imported by
                            server.js AND targeting.js; without it the server
                            does not boot)
src/engine/bot.js          src/engine/cards.js      src/engine/rng.js
src/engine/score.js        src/decks/index.js       src/decks/lists.js
src/data/oracle.json       src/data/gamechangers.json
src/data/coverage.json     src/data/validation.json
package.json               README.md                SETUP.md        .env.example
scripts/run-tests.mjs      scripts/sweep.mjs        scripts/simall.mjs
tests/engine.test.mjs      tests/ui.test.mjs        tests/community.test.mjs
```

Anything under `src/` that you are unsure about: upload it. The whole thing is 49 files (~1 MB of source, ~290 KB zipped)
compressed, and every module under `src/` is reachable from the server's import graph — a missing file
is a crash on boot, never a quiet degradation.

Command line, if you have the repo cloned (fastest of all — and it cannot miss a file):

```bash
cd /path/to/your/clone
rsync -av --delete   --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '*.zip'   ~/commander-daily/ ./
git add -A && git commit -m "Hand cards show art + rules text, one action dock, target gating, report-a-card"
git push
```

### Optional: turn on deck moderation

Uploads are public and only checked mechanically, and deck *names* are free text shown in the rotation.
To be able to remove one: Render → your service → **Environment** → add `ADMIN_TOKEN` (any long random
string) → save (the service restarts), then

```bash
curl -s -X POST https://YOUR-APP.onrender.com/api/community/remove \
  -H 'content-type: application/json' \
  -d '{"id":"<deck id from /api/community>","token":"<ADMIN_TOKEN>"}'
```

With no `ADMIN_TOKEN` set the endpoint refuses to act at all.

### Confirm the deploy

```bash
# 1. the new client is live (three tabs, three zones per player)
curl -s https://YOUR-APP.onrender.com/ | grep -c 'data-pane'          # expect 3
curl -s https://YOUR-APP.onrender.com/ | grep -c 'myZoneCreatures'    # expect 1
# 2. the new server is live
curl -s https://YOUR-APP.onrender.com/api/community                   # expect {"ok":true,"decks":[...]}
curl -s https://YOUR-APP.onrender.com/healthz                         # store must still say "upstash"
# 3. the daily survives a restart — the check that actually matters
node scripts/deploy-smoke.mjs https://YOUR-APP.onrender.com phase1
node scripts/deploy-smoke.mjs https://YOUR-APP.onrender.com phase2
```

`phase2` must print `✓ identical state — the daily survived the restart`. If it does not, the store is
not shared between restarts — see §1. A cold free-tier instance takes 30–60 s to wake, so the first
request after a deploy may be slow; that is expected, not a failure.

On a VPS: `git pull && sudo systemctl restart commander-daily`, then the same checks.

---

## 8. Sources

Checked 2026-10-15, because free tiers change constantly:

- Render free tier — [render.com/docs/free](https://render.com/docs/free) (via [agentdeals 2026-10](https://agentdeals.dev/vendor/render), [unanswered.io 2026-08](https://unanswered.io/guide/render-free-tier-details), [servercompass](https://servercompass.app/blog/render-pricing-is-it-worth-it)): 750 instance hours/workspace/month, spin-down after 15 min idle, no persistent disk, free Postgres expiry, free Key Value (25 MB, not continuously persisted).
- Upstash Redis free tier — [upstash.com/docs/redis/overall/billing](https://upstash.com/docs/redis/overall/billing): 1 database, 256 MB data, 500K commands/month, 10 GB bandwidth, no credit card, REST API counts one command per request.
- Oracle Cloud Always Free — [site2us.com 2026-09](https://site2us.com/en/servers/oracle-cloud-free-tier), [itechguides 2026-08](https://www.itechguides.com/oracle-cloud-giving-away-ampere-arm-a1-instances-always-free-the-2026-limits-explained/): 2 OCPU / 12 GB Arm, 200 GB storage, 10 TB egress, home-region-only, idle reclamation thresholds, June 2026 halving.
- Cloudflare Workers free plan — [developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits) (via [agentdeals 2026-10](https://agentdeals.dev/vendor/cloudflare-workers)): 100k requests/day, **10 ms CPU per invocation**.
