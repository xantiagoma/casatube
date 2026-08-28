# Handoff

Read this first, then `PLAN.md` for decisions and `WORKLOG.md` for history.
Everything below was true at the last commit on this file.

---

## What CasaTube is

A self-hosted media downloader that **does not lose your work**. It replaces
HomeTube, which runs its jobs inside the browser session and loses them when the
tab closes — measured: 3 of 3 downloads died mid-way.

**Repository**: <https://github.com/xantiagoma/casatube> (private)
**Working copy**: `/home/santi/Projects/casatube` on **ohana**

## Running right now

```
http://ohana.tail9273dc.ts.net:8520
```

🔴 **It is a CasaOS-managed Compose app now, not a hand-run container.** The
compose lives in the *other* repo, at
`/home/santi/Projects/personal-agent/media/casatube/docker-compose.casaos.yml`,
and CasaOS keeps its own copy under `/var/lib/casaos/apps/casatube/`. Redeploy:

```bash
cd /home/santi/Projects/casatube
docker build --build-arg YTDLP_VERSION=2026.08.19 -t casatube:latest .
casaos-cli app-management apply \
  -f /home/santi/Projects/personal-agent/media/casatube/docker-compose.casaos.yml
./scripts/smoke.sh          # ⚠️ not optional — see below
```

⚠️ **Do not `docker rm -f casatube && docker run ...` any more.** It works, and
it leaves CasaOS's record pointing at a container that no longer exists — the
menu entry stops matching the thing that is running. The same class of mistake
as running `docker compose` by hand against a Dokploy app.

⚠️ **`curl /api/health` does not tell you the app works.** A client bundle that
fails to build leaves every route answering 200 while the page is blank. Use
`scripts/smoke.sh`, which fetches the page and the script it references.

## The library is the real one now

`LIBRARY_DIR=/mnt/mailmedia/videos` — Santi's actual media root, the same one
HomeTube used, with `Dramas`, `Web` and `Videos` offered as destinations.

🔴 **The container binds `/mnt/mailmedia`, the *parent*, with
`propagation: rshared` — never `videos` itself.** `videos` is an rclone FUSE
mount: mounting it directly captures the FUSE handle that existed at container
start, so the first time rclone remounts, the container is holding a stale one
and the library reads as empty. Binding the parent is what let HomeTube survive
remounts, and it is why nothing is mounted at `/library` any more.

⚠️ **`PUID`/`PGID` do not decide ownership here.** rclone connects to `mail` as
root, so files land `root:root` on the far side; `UMASK 022` is what makes them
readable. Changing PUID/PGID to fix a permissions problem on this library will
do nothing.

⚠️ `CREDENTIALS_KEY` lives in `~/casatube.env` (mode 600) and in
`/DATA/AppData/casatube/casatube.env`. Lose it and stored credentials cannot be
decrypted — each row records which key sealed it and says so. Encryption is
**optional by Santi's decision**; without a key it stores plain text and says so
loudly.

## State

**1120 tests, 0 failures. `tsc` clean.** 51 commits.

Working end to end: paste a URL → the form shows the resolutions, audio tracks
and subtitles that video actually has → queue → six stages live over SSE → the
file lands correctly language-tagged. Library with thumbnails, playback (HLS
remux on demand, real seeking), downloads, trash with restore. Sources,
scheduler, storage, analytics, notifications, plugins with an editor **whose
hooks now actually fire**, credentials, settings editing, transcoding.

✅ **Deployed 2026-08-28**, and then moved onto the real stack by the
`personal-agent` session: CasaOS menu entry, `restart: unless-stopped` (it had
none — it would not have survived the reboot ohana has pending),
`TZ=America/Bogota`, and the library repointed at `/mnt/mailmedia/videos`.
Jellyfin is configured with an API key of its own, so it can be revoked without
touching anything else, and the plugin reports `state: active`,
`missingSettings: []`. HomeTube and metube are uninstalled.

Rollback images, newest first: `casatube:new`, `casatube:test`. Database backups
from before each deploy: `/DATA/AppData/casatube/backup-20260828-predeploy/` and
`-20260828b-predeploy/`.

Verified against YouTube, Odysee and Dailymotion.

## Still open

- **`arm64` was never built.** The Dockerfile selects the right yt-dlp, only
  amd64 was exercised.
- **No paging control on the job screens.** The server sorts, searches and
  counts now, and the table says "200 of 3,412" — but the rest is reachable
  only by narrowing the search, not by turning a page.
- **A plugin cannot be switched *on* for one download.** Off works; on cannot,
  because a plugin that is off server-wide is never activated and registers no
  hooks. Doing it properly means activating every valid plugin and gating
  dispatch on `enabled` — a change to the runtime's model, not a UI change.
- `react-doctor` sits around 60/100, dominated by vendored Dice UI.

### Closed on 2026-08-28 (see `WORKLOG.md`)

Six items, and two of them were much bigger than they read:

- 🔴 **Plugins never ran.** No hook was dispatched at any point — the worker
  was never handed the runtime. Everything visible said otherwise.
- 🔴 **The live queue stopped showing new work past 200 jobs**, because the SSE
  snapshot was the *oldest* 200.
- `GET /api/jobs` takes `sort`, `order`, `q`, `bucket` and answers with `total`
  and counts; per-download plugin opt-out; `POST /api/jobs/:id/priority`;
  `automaticSubtitles`; automatic `notifications` retention; `FFMPEG_BIN`
  reaching yt-dlp.

## Santi's standing instructions

- **Do the work; don't ask for authorisation.** Report what needs review.
- **Everything in English** — code, comments, docs, UI.
- **Spanish when talking to him.**
- Encryption, auth and similar are **not** hard requirements for a self-hosted
  tool. Offer them, don't gate on them.

## How to work here

**Contracts before parallel work.** `src/core/{schema,types,errors,plugins}.ts`
are what everything depends on. Agree them, commit them, then fan out — the
first attempt at this project was thrown away because work went to parallel
agents before the requirements had settled.

**A feature that exists only as an endpoint is not done.** This happened five
times: credentials, transcoding, settings, pause/resume, applicable plugins.
Before reporting anything complete, audit **call sites**, not words:

```bash
# for each src/api/*.ts, is its prefix actually called from src/web?
```
Searching for the string `settings` found plugin settings and reported the
settings API as wired while five screens did not exist.

🔴 **And the sixth time it was the middle that was missing.** Plugins had an
API, a Settings screen, a per-URL "these apply" panel and a working loader —
and no caller anywhere in the pipeline, so not one hook ever fired. Auditing
call sites at *both* ends would still have missed it: both ends existed. The
check that found it was a plugin that logged at every point, installed on a
running server. **If a feature's only evidence is that its parts exist, make it
say something out loud and go and look.**

**Never use `pkill` or `killall`** — they have killed the running container.
Kill by exact PID. Bun binds with `SO_REUSEPORT`, so a second server on a busy
port succeeds and the kernel splits traffic between them; `ss -lptn` is the
check.

## The two habits this project earned

**Verify the instrument, not the result.** Again and again something passed for
the wrong reason: a test asserting on the thing next to the thing; `grep -c`
counting commented-out lines as enabled config; a paginated registry making a
published version look missing; a helper returning "unavailable" that turned a
content assertion into a test which always passed; a security check that could
not have seen the secret it was looking for. **Break the code on purpose and
check the test notices.** A check nobody has seen fail is not yet a check.

**Never substitute in silence.** HomeTube's language tags, a codec that does not
exist at the requested resolution, a subtitle failure taking a video down with
it, a bundle shipping one file instead of three, `MAX_CONCURRENT_DOWNLOADS`
documented in three places and read in none. Every one of them looked like it
was working.

📌 And the most expensive lesson: **the plausible explanation that fits the
symptom is not the cause.** A 438 MB video hung, I reasoned it was too large to
hand a browser progressively, and I was wrong — the same bytes remuxed load in
one request. It was a *fragmented* MP4, which costs 468 requests and 3.74 GB to
open. My explanation survived precisely because it sounded right.

## Where the knowledge is

| | |
|---|---|
| `PLAN.md` | Every decision **and the reasoning that lost** |
| `WORKLOG.md` | What happened, newest first |
| `docs/DISCOVERIES.md` | ~25 traps already paid for — **read it before touching anything** |
| `docs/mockups/` | The reference designs |
| `docs/DEPLOY.md` | Environment variables, volumes, updating yt-dlp |

## The other repo

`/home/santi/Projects/personal-agent` is Santi's infrastructure repo — the
gateway, three servers, the home network, cameras, home automation. Unrelated to
CasaTube except that CasaTube runs on ohana. Its `START-HERE.md` and
`./scripts/doctor.sh` are the way in. **The camera monitor there is stopped** at
his request; open items live in its `plans/backlog.md`.
