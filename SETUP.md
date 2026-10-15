# Setup walkthrough — Render free + Upstash free

A click-by-click version of `DEPLOY.md` §2, written for the point where it usually goes wrong: getting the code into a Git host that Render can read, and getting Render to actually see that repo.

**What you need:** ~20 minutes, a browser, and Node 20+ if you want to test locally first. No credit card, no custom domain, nothing to install on a server.

The end state: a public URL like `https://commander-daily.onrender.com` that anyone can play, with one daily attempt per player enforced server-side.

---

## Step 0 — Get the code onto your machine

Every path below starts with the project files on your own computer. Download **`commander-daily.zip`** from this workspace, then:

```bash
unzip commander-daily.zip -d commander-daily
cd commander-daily
```

Windows: right-click the zip → **Extract All**, then open a terminal in that folder.

Optional but recommended — prove it runs before you deploy anything:

```bash
node --version              # needs v20 or newer
node --test tests/          # expect: # pass 34 / # fail 0
node src/server/server.js   # then open http://localhost:3000
```

There are **zero npm dependencies**, so there is nothing to install and no build step. If `node --test` says 34 passing, everything you're about to deploy is working.

---

## Step 1 — The store (Upstash) — ~5 minutes

Render's free web service has no disk: it wipes its filesystem on every spin-down, restart and redeploy. So the game state lives in Upstash instead.

1. Go to **[upstash.com](https://upstash.com)** → *Sign up* (Google/GitHub/email — no card).
2. **Create Database** → make sure the type is **Redis** (not Kafka, QStash or Vector — only Redis has the REST API this app uses). Name it `commander-daily`, pick the region near your Render region (e.g. `us-east-1` ↔ Render **Ohio/Virginia**; `eu-central-1` ↔ Render **Frankfurt**), leave everything else at default → **Create**.
3. Now find the two values. **There is no username.** If a screen asks for a username, you're looking at the wrong credentials — see the box below.

### Where the two values are

Open the database and try these, in order — Upstash has moved these labels around:

| Where | What you'll see |
|---|---|
| The database page itself, lower down | A **REST API** section with `Endpoint` and `Token` fields. Hover each → a copy button appears. |
| **Connect** button, top-right of the database page | Tabs: `Node`, `Python`, **`REST`**, `.env`. Pick **REST** → `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The **`.env`** tab has both in paste-ready form. |
| **Details** tab → **REST API** → **`.env`** | The same two lines. |

Copy:

- the **Endpoint / REST URL** — it looks like `https://us1-merry-cat-32748.upstash.io`
- the **Token** — a long string, roughly 40+ characters

That's it. Two values, no username, no port, no password.

> **"But it's asking me for a username."** Upstash has *two* ways to connect, and the console shows both. The **TCP / Redis-protocol** view (the `redis-cli` or "Redis client" tab) gives a connection string like `rediss://default:PASSWORD@host:6379` — there the username is literally `default` and the password is a *different* secret. This app doesn't use TCP at all; it talks to the **REST** endpoint over HTTPS. So ignore that panel: no username, no password, no port. If what you copied starts with `redis://` or `rediss://`, or contains a `:6379`, it's the wrong one.

> **Check the "Read-Only Token" switch is OFF** before copying. With it on, you get a token that can read but not write — reads pass, then every save fails and the daily silently breaks. The verifier below catches exactly this.

### Verify the credentials *before* Render

One command, against the real database, no deploy involved:

```bash
node scripts/check-kv.mjs https://us1-merry-cat-32748.upstash.io <your-token>
```

It does a `PING`, then writes, reads back and deletes a throwaway key, and it names the fix when something's wrong:

```
  ✓ endpoint reachable and the token authenticates
  ✓ the token can write (SET succeeded)
  ✓ it can read back what it wrote (GET succeeded)
  ✓ cleaned up the test key
```

If it says `WRONGPASS`, the token is mistyped, truncated, or the read-only one. If it says the URL is a TCP one, you copied from the wrong panel. Getting a green here means anything that breaks later is a Render configuration problem, not a credential problem — which is a much better place to be debugging from.

**Free tier:** 256 MB, 500,000 commands/month, no card. Every write here is one `SET` of a debounced snapshot, so a few hundred daily players costs a few thousand commands a month. You will not get close.

> **Don't want to sign up yet?** `node scripts/fake-kv.mjs` runs a local stand-in of the same protocol, so you can rehearse the whole deployment path — including `npm run smoke` — on your own machine first.

## Step 2 — Get the code into Git

Render needs a repo it can read. Pick whichever of these matches your situation.

### 2A — GitHub from the command line

```bash
cd commander-daily
git init -b main
git add -A
git commit -m "Commander Daily"
```

Create the repo: **github.com → New repository** → name it `commander-daily` → **Public or Private both work** → **do not** add a README, .gitignore or licence (you already have files) → **Create repository**.

```bash
git remote add origin https://github.com/<your-username>/commander-daily.git
git push -u origin main
```

**When it asks for a password, your GitHub password will not work** — GitHub removed password auth in 2021. Paste a **Personal Access Token** instead:

> github.com → your avatar → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)** → tick the **`repo`** scope → set an expiry → **Generate** → copy it and paste it as the password. Git will remember it if you run `git config --global credential.helper store` (macOS: `osxkeychain`; Windows: `manager`).

**Prefer SSH?** No token juggling:

```bash
ssh-keygen -t ed25519 -C "you@example.com"     # press Enter through the prompts
cat ~/.ssh/id_ed25519.pub                      # copy this line
# github.com → Settings → SSH and GPG keys → New SSH key → paste → Add
ssh -T git@github.com                          # expect: "Hi <you>! You've successfully authenticated"
git remote set-url origin git@github.com:<your-username>/commander-daily.git
git push -u origin main
```

**Common errors:**

| Message | Cause | Fix |
|---|---|---|
| `Support for password authentication was removed` | you typed your account password | use the PAT (above) or SSH |
| `Permission denied (publickey)` | the key isn't on GitHub, or you're still on the HTTPS remote | `ssh -T git@github.com`; if that fails, re-add the key |
| `ssh: connect to host github.com port 22: Connection timed out` | network/ISP blocks port 22 | use SSH over 443 — add to `~/.ssh/config`: `Host github.com` / `HostName ssh.github.com` / `Port 443` / `User git`, then retry |
| `src refspec main does not match any` | nothing committed, or your branch is `master` | `git add -A && git commit -m "…"`, then `git push -u origin $(git branch --show-current)` |
| `remote origin already exists` | ran `remote add` twice | `git remote set-url origin <url>` |
| `RPC failed` / `HTTP 400` on push | flaky connection, or a proxy | retry; `git config --global http.postBuffer 524288000` |

### 2B — GitHub Desktop (no terminal at all)

Install [GitHub Desktop](https://desktop.github.com) → **File → Add local repository** → choose the unzipped `commander-daily` folder → it offers to create a repository there → **Publish repository**. If you want the "public repo URL" shortcut in 2C, untick *Keep this code private*.

### 2C — Skip GitHub entirely

Three real options, in order of least effort:

1. **GitLab or Bitbucket.** Render connects to all three. If you already have one of those accounts, push there instead (`git remote add origin git@gitlab.com:<you>/commander-daily.git`) and use the normal Blueprint flow — everything else is identical.
2. **Public Git repository URL (no account linking at all).** In Render: **New → Web Service → Public Git Repository**, paste `https://github.com/<you>/commander-daily` and click **Connect**. Render clones it without ever seeing your GitHub account. Requires the repo to be **public**, and you lose auto-deploy — after pushing a change you press **Manual Deploy → Deploy latest commit**. For a finished game this is a perfectly good trade, and it sidesteps the whole "connect GitHub" step that's giving you trouble.
3. **No Git host, no Render link.** Either deploy the Docker image (`Dockerfile` is in the repo): `docker build -t <you>/commander-daily . && docker push <you>/commander-daily:latest`, then Render **New → Web Service → Existing Image** → `docker.io/<you>/commander-daily:latest`. Or use the **Oracle Always Free VM** — `DEPLOY.md` §3 — where you upload the files and never touch Git.

### 2D — Render can't see your repo (when you *do* connect GitHub)

This is the step that most often "doesn't connect". Render doesn't get blanket access to your account; you install its GitHub App and then pick repos:

1. Render dashboard → your avatar → **Account Settings** → **GitHub** → **Configure account** (or **Install**).
2. On GitHub's install screen, choose **Only select repositories** and tick `commander-daily` (or give it all repos), then **Install & Authorize**.
3. Refresh the Render page — the repo now appears in **New → Blueprint** and **New → Web Service**.
4. **Repo still missing?**
   - Private repo → it must be explicitly ticked in the app's **Repository access** list (github.com → Settings → Applications → Render → Configure).
   - Repo in an organisation → an org owner may have to approve the request ("Request approval" on the same page).
   - Still nothing → log out of Render and back in, or use route 2C.2 (public repo URL), which needs no account link.

---

## Step 3 — Render — ~5 minutes

### 3A — Blueprint (uses the repo's `render.yaml`)

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
2. Pick the repo → **Connect**. Render reads `render.yaml` and shows what it will create: one free Node web service named `commander-daily`, health check `/healthz`.
3. It prompts you for the two values marked `sync: false` — paste the Upstash pair from Step 1:
   - `KV_REST_API_URL` = `UPSTASH_REDIS_REST_URL`
   - `KV_REST_API_TOKEN` = `UPSTASH_REDIS_REST_TOKEN`
   (Or paste them under their own Upstash names, `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — the app reads either pair.)
   `SESSION_SECRET` is generated for you; `STORE_BACKEND=upstash` and `TRUST_PROXY=1` come from the file.
4. **Apply**. First deploy takes about a minute. Your URL appears at the top of the service page.

### 3B — Manual web service (no Blueprint)

**New → Web Service** → your repo → then:

| Field | Value |
|---|---|
| Runtime | **Node** |
| Build command | `npm install --no-audit --no-fund` (there are no dependencies; this is just a no-op) |
| Start command | `node src/server/server.js` |
| Health check path | `/healthz` |
| Instance type | **Free** |

Under **Environment**, add:

```
SESSION_SECRET     <openssl rand -hex 32>   # or any long random string
ADMIN_TOKEN        <any long random string> # optional: enables deck moderation
STORE_BACKEND      upstash
KV_REST_API_URL    <UPSTASH_REDIS_REST_URL>
KV_REST_API_TOKEN  <UPSTASH_REDIS_REST_TOKEN>
TRUST_PROXY        1
```

> **Do not skip `SESSION_SECRET`.** Without it the server makes a new random one at each boot, which invalidates every cookie — every player's in-progress daily becomes unreachable after every restart and deploy.

> **Why not Render's own free Key Value?** It's in-memory only: Render's docs say *"whenever an instance restarts, all of its data is lost"*, and they may restart it at any time — so the leaderboard would evaporate. Its connection string is also `redis://…` (TCP), not the Upstash REST endpoint this backend speaks. Upstash's free tier is durable; that's the whole reason for the second tab.

---

## Step 4 — Verify it actually works

```bash
curl https://<your-app>.onrender.com/healthz
# {"ok":true,"day":"2026-10-15","decks":10,"store":"upstash","dirty":false,...}
```

`"store":"upstash"` is the important part — it means the app is talking to Upstash rather than a local file that will vanish.

Then prove the restart-safety promise, which is the whole point of the external store:

```bash
node scripts/deploy-smoke.mjs https://<your-app>.onrender.com phase1
# play a few turns; it saves your cookie + board fingerprint to /tmp

# now force a restart: Render dashboard → your service → Manual Deploy,
# or just wait 15+ minutes idle so it spins down

node scripts/deploy-smoke.mjs https://<your-app>.onrender.com phase2
```

Success looks like:

```
PHASE 2 — resumed: true
  ✓ identical state — the daily survived the restart
  finished: over | points: 19
  leaderboard entry: #1 DeploySmoke 19pts won=true
```

Phase 2 fails loudly (and tells you the filesystem was wiped) if the store isn't shared — that's the day-one deployment bug this test exists to catch. Submitting twice should return `409 You already submitted today.`

---

## Step 5 — Keep it awake, then announce it

- **Cold starts.** Free services sleep after 15 minutes of no traffic; the next visitor waits 30–60 s. You get **750 instance-hours/month** and one always-on service needs 744, so point a free pinger ([cron-job.org](https://cron-job.org), UptimeRobot, or a GitHub Actions cron) at `https://<your-app>.onrender.com/healthz` every 10–14 minutes and it never sleeps. Keep to **one** free web service so you don't blow the shared pool.
- **Custom domain** (optional): Render → Settings → Custom Domains; free TLS is automatic.
- **Backups:** the whole store is one value in Upstash; copy it weekly from the console if you care about the leaderboard history.

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank / dark page, or only a small empty box — nothing else | an author `display` rule beating the `hidden` attribute (the modal backdrop covers the whole page) | the `[hidden] { display: none !important; }` guard must be present in `public/style.css`; `tests/ui.test.mjs` enforces it |
| Health check fails, service never goes live | wrong start command, or the app crashed | check **Logs**; locally reproduce with `node src/server/server.js` |
| Works, then everyone's run/leaderboard disappears after idle | `STORE_BACKEND` isn't `upstash`, or the KV vars are missing | `/healthz` should say `"store":"upstash"` |
| `SESSION_SECRET` missing (or changed) | set it once, leave it |
| One person's 429s block others behind a shared IP | `TRUST_PROXY` not set | add `TRUST_PROXY=1` |
| `deploy-smoke phase2` says the state changed | store isn't shared between restarts | same as row 2 |
| Push rejected / can't reach GitHub | auth or port 22 | see the Step 2A table, or use 2C.2 / 2C.3 |
