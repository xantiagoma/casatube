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

Container `casatube`, image `casatube:test`, on ohana. Rebuild and redeploy:

```bash
cd /home/santi/Projects/casatube
docker build --build-arg YTDLP_VERSION=2026.08.19 -t casatube:test .
docker rm -f casatube
docker run -d --name casatube -p 8520:8520 \
  -e PUID=1000 -e PGID=1000 -e UMASK=022 \
  --env-file /DATA/AppData/casatube/casatube.env \
  -v /DATA/AppData/casatube/data:/data \
  -v /DATA/AppData/casatube/library:/library \
  casatube:test
./scripts/smoke.sh          # ⚠️ not optional — see below
```

⚠️ **`curl /api/health` does not tell you the app works.** A client bundle that
fails to build leaves every route answering 200 while the page is blank. Use
`scripts/smoke.sh`, which fetches the page and the script it references.

⚠️ The library is a **scratch** directory (`/DATA/AppData/casatube/library`),
**not** Santi's real Jellyfin library. Pointing it at `/mnt/mailmedia/videos` is
a decision he has not made yet.

⚠️ `CREDENTIALS_KEY` lives in `~/casatube.env` (mode 600) and in
`/DATA/AppData/casatube/casatube.env`. Lose it and stored credentials cannot be
decrypted — each row records which key sealed it and says so. Encryption is
**optional by Santi's decision**; without a key it stores plain text and says so
loudly.

## State

**1003 tests, 0 failures. `tsc` clean.** 42 commits.

Working end to end: paste a URL → the form shows the resolutions, audio tracks
and subtitles that video actually has → queue → six stages live over SSE → the
file lands correctly language-tagged. Library with thumbnails, playback (HLS
remux on demand, real seeking), downloads, trash with restore. Sources,
scheduler, storage, analytics, notifications, plugins with an editor,
credentials, settings editing, transcoding.

Verified against YouTube, Odysee and Dailymotion.

## Still open

- **No per-job plugin override.** `POST /api/jobs` accepts nothing about
  plugins, so the download window shows which apply and states that on/off is
  server-wide. Santi asked for a per-download switch; it needs a column and
  dispatch changes first.
- **`GET /api/jobs` has no `sort`, `order` or `q`** — the screens sort the 200
  already fetched. Past 200 jobs "the largest failed download" quietly becomes
  "the largest of the latest two hundred".
- **No priority-change endpoint.** Priority is set at enqueue only.
- **`Preferences` cannot refuse auto-generated subtitles.**
- **`notifications` grows until purged** — no automatic retention.
- **`FFMPEG_BIN` never reaches yt-dlp**, which finds ffmpeg on `PATH` only.
- **`arm64` was never built.** The Dockerfile selects the right yt-dlp, only
  amd64 was exercised.
- `react-doctor` sits around 60/100, dominated by vendored Dice UI.

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
