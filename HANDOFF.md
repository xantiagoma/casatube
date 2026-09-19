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
casaos-cli app-management apply casatube \
  -f /home/santi/Projects/personal-agent/media/casatube/docker-compose.casaos.yml
./scripts/smoke.sh          # ⚠️ not optional — see below
```

⚠️ **`casatube` there is the appid and it is positional.** Written as
`apply -f <file>` the command prints its usage to stderr, exits 1 and applies
**nothing** — with stdout empty, so a redirected log shows a clean step that did
not happen. `casaos-cli app-management list apps` prints the appids.

⚠️ **`apply` is asynchronous.** Looking at the container immediately afterwards
shows the old one. Wait for the recreate, then let `smoke.sh` decide.

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

**1201 tests, 0 failures. `tsc` clean.** 67 commits.

Working end to end: paste a URL → the form shows the resolutions, audio tracks
and subtitles that video actually has → queue → six stages live over SSE → the
file lands correctly language-tagged, under a name you can choose and that never
overwrites anything. Library with thumbnails, playback (HLS
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

Verified against YouTube, Odysee and Dailymotion — and against a **private
Telegram channel**, which is a provider of its own (see below).

## Two providers of our own, ahead of yt-dlp

`register` inserts in front of the yt-dlp catch-all, which is what PLAN §5 means
by *"a custom extractor for a site yt-dlp covers badly"*. Both claim narrowly, and
both leave the fallback reachable for everything they do not claim.

### Google Drive — `providers/drive.ts`

🔴 yt-dlp's Drive extractor asks `googleapis.com/drive/v3` for metadata with an
API key **compiled into yt-dlp and shared by every one of its users**. When that
key is refused the extractor aborts *at extraction* and writes nothing — measured
here as 429 for yt-dlp and 403 for the same key from curl. It is a download that
cannot happen for a reason nobody downstream can influence.

So this skips the key: ask `drive.usercontent.google.com`, follow Drive's
virus-scan form when a large file gets one, stream the answer, and **verify the
bytes written against the stated total** — a reset connection ends a stream and
everything looks finished otherwise.

⚠️ It is scraping and will need maintenance the Telegram provider does not.
`confirmTarget` parses every hidden input rather than looking for `confirm=t`, so
a renamed token survives. **Public files only** — a private one is reported as
`AuthRequired` naming a cookies credential for `drive.google.com`, and that path
is untested.

📌 Files, never folders: a folder is a listing, and claiming it would fail on
something a person could reasonably paste.

### Vidarro — a plugin, not a provider

📌 The instructive one. yt-dlp has no Vidarro extractor and its generic fallback
finds the Voomly embed and answers `Unsupported URL` — but handed the HLS manifest
directly it is entirely at home, ladder and all. So what was missing was
**extraction, not download**, and `url:resolve` is the hook for exactly that:
`src/plugins/builtin/vidarro.ts` turns the share page into the manifest and yt-dlp
does the rest.

🔴 It returns the **master** manifest, never `file720p.m3u8`. A per-quality URL
works while hard-coding the resolution, which would leave the ceiling in
Preferences with nothing to decide — and nothing about that looks like a failure.

⚠️ The title comes out as `file`, because that is what the manifest calls it. The
*Save as* field is where to fix that per download; reading the real title would
need a `probe:complete` hook, since a `url:resolve` can only return a URL.

## Telegram

🔴 `providers/telegram.ts` is the one source yt-dlp cannot reach: a private
channel's video is never an HTTP URL, it arrives as MTProto chunks. It claims
**private links only** (`t.me/c/<channel>/<message>`) — public ones keep going to
yt-dlp's `telegram:embed`, because claiming a URL it cannot serve would make the
fallback unreachable.

The session is a `custom` credential scoped to `t.me`, holding `apiId`,
`apiHash` and `session`, sealed with `CREDENTIALS_KEY`. Two ways to create one:

- **Settings → Credentials → Telegram** — a three-step dialog.
- `bun scripts/telegram-session.ts` — prints a session string for the headless
  path. Pass `CASATUBE_TG_API_ID` and `CASATUBE_TG_API_HASH` as environment
  variables rather than pasting them; that page shows them beside a multi-line
  RSA key, and a newline in a prompt ends it early.

📌 The RSA public key `my.telegram.org` shows is **not** an input. `teleproto`
carries Telegram's own server keys.

⚠️ `core/telegram-login.ts` is **the only thing in this process that holds state
between requests**, and it has to: Telegram's `phoneCodeHash` dies with the
connection that asked for the code, so the two steps share a live client. It
expires, it is capped at three, and it does not survive a restart — the dialog
says so. Nothing is written until the last step, so a lost login is a login to
start again.

⚠️ A Telegram session is the **whole account**, not a per-channel token. Deleting
the credential here does not revoke it; only Telegram → Settings → Devices does.

## Still open

- **`arm64` was never built.** The Dockerfile selects the right yt-dlp, only
  amd64 was exercised.
- **No paging control on the job screens.** The server sorts, searches and
  counts now, and the table says "200 of 3,412" — but the rest is reachable
  only by narrowing the search, not by turning a page.
- **Telegram: a single-format source still obeys the resolution ceiling.** A 4K
  Telegram video under a 1080 ceiling fails with `FormatUnavailable` rather than
  taking the only file that exists. Coherent with yt-dlp, and friction with no
  prize for a source that has no ladder. Not changed because it is shared logic.
- **Public `t.me` links go to yt-dlp, not to the Telegram provider.** Routing
  them through the session would probably work better, but the regression could
  not be tested.
- **A plugin cannot be switched *on* for one download.** Off works; on cannot,
  because a plugin that is off server-wide is never activated and registers no
  hooks. Doing it properly means activating every valid plugin and gating
  dispatch on `enabled` — a change to the runtime's model, not a UI change.
- `react-doctor` sits around 60/100, dominated by vendored Dice UI.

### Closed on 2026-09-19 (see `WORKLOG.md`)

- **Google Drive**, as a provider of our own, because yt-dlp's path depends on a
  shared API key that is being refused.
- **Vidarro**, as a bundled `url:resolve` plugin — and the gap it exposed:
  `url:resolve` ran on the enqueue path only, so *Analyze* refused a link the
  queue downloaded happily.
- **Telegram**, end to end: the provider, the credential plumbing that made a
  `custom` credential reachable at all, and the sign-in dialog.
- 🔴 **Resolution was the height**, so every portrait video was refused by the
  default ceiling — a YouTube Short as much as a Telegram clip. `resolutionOf`
  is the shorter side now.

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
