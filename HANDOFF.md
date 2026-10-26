# Handoff

Read this first, then `PLAN.md` for decisions and `WORKLOG.md` for history.
Everything below was true at the last commit on this file.

---

## What CasaTube is

A self-hosted media downloader that **does not lose your work**. It replaces
HomeTube, which runs its jobs inside the browser session and loses them when the
tab closes — measured: 3 of 3 downloads died mid-way.

**Repository**: <https://github.com/xantiagoma/casatube> — **public since
2026-10-26**, with **v0.1.0** released: `ghcr.io/xantiagoma/casatube` (public,
amd64 + arm64, pulled anonymously and smoke-tested after publishing) and the
site at <https://me.xantiagoma.com/casatube/>.

📌 **This file is about the code, not about any one server.** The maintainer's
own deployment — hostnames, the library mount, backups, the CasaOS redeploy —
lives in a separate infrastructure repository. Generic deployment is
`docs/DEPLOY.md`; how images are built and published is the
[Releases](#releases) section below.

⚠️ **`curl /api/health` does not tell you the app works.** A client bundle that
fails to build leaves every route answering 200 while the page is blank. Use
`scripts/smoke.sh`, which fetches the page and the script it references — after
every deploy, and CI runs it against every image it builds.

## State

**1219 tests, 0 failures. `tsc` clean.**

Working end to end: paste a URL → the form shows the resolutions, audio tracks
and subtitles that video actually has → queue → six stages live over SSE → the
file lands correctly language-tagged, under a name you can choose and that never
overwrites anything. Library with thumbnails, playback (HLS
remux on demand, real seeking), downloads, trash with restore. Sources,
scheduler, storage, analytics, notifications, plugins with an editor **whose
hooks now actually fire**, credentials, settings editing, transcoding.

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

## Releases

`.github/workflows/release.yml` publishes `ghcr.io/xantiagoma/casatube` for
**amd64 and arm64**, each built natively on its own runner and joined into one
multi-arch tag afterwards.

| trigger | tags |
|---|---|
| tag `vX.Y.Z` | `X.Y.Z-ytdlp-<date>`, `X.Y.Z`, `X.Y`, `latest` + a GitHub release |
| push to `main` | `main`, `sha-<short>` |
| weekly, or by hand | the latest release again, with the newest yt-dlp |

🔴 **The weekly rebuild is the point.** yt-dlp rots when sites change; the app
version does not. So the latest release is rebuilt with the newest yt-dlp under a
*new* immutable tag, and `X.Y.Z`/`latest` move to it. Nothing published is ever
overwritten with different bytes, and a combination that exists already is
skipped.

The project site, <https://me.xantiagoma.com/casatube/>, is `site/index.html`
assembled with the logo and screenshots by `scripts/pages-build.sh` and deployed
by `pages.yml` — only from a public repository, since Pages on a private one
still publishes a public site. Owner, once: Settings → Pages → Source: GitHub
Actions.

To cut a release: bump `version` in `package.json` (the workflow refuses a tag
that disagrees with it — `/api/health` reports that version), add a section to
`CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push --tags`.

📌 arm64 is built and smoke-tested **natively** on `ubuntu-24.04-arm`, in CI and
in releases — first exercised on 2026-10-26, and it passed: the image builds,
starts, serves the bundle and runs its yt-dlp.

## Still open

- 🔴 **`bun run dev` restarts in a loop** — `--watch` sees the plugin
  runtime's shadow copy deleted after import (`docs/DISCOVERIES.md`). Use
  `bun start` for now. The likely fix is keeping the shadow until the next load
  sweeps it, which changes a rule `importThrough` states, so it was not done in
  passing.
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
  dispatch on `enabled` — a change to the runtime's model, not a UI change,
  and one that would run the `setup` of plugins someone switched off, so "off"
  would stop meaning off. Left alone deliberately on 2026-10-26.
- **Some PeerTube files have no format label.** yt-dlp reports their codec as
  unknown, so video.blender.org downloads show "—" in the Format column and no
  resolution rows in the form — the download itself still gets 1080p.
- A job cancelled after a failure shows only "Cancelled"; why it had failed is
  in its log, not in the row.
- `react-doctor` sits around 60/100, dominated by vendored Dice UI.

### Closed on 2026-10-26 (see `WORKLOG.md`)

Before going public, everything a first-time user would trip over: resolution
labels by the class a person calls them (1920×800 is 1080p), yt-dlp's raw errors
turned into sentences with the original one click away, job lists that fit a
phone, failed-or-cancelled named "Stopped" and counted the same everywhere, a
merging job that says "processing" instead of sitting at 100% "Downloading", a
plugin badge that counts plugins that will actually run, `?section=` in
Settings that scrolls there, and real paging on the job screens.
`docs/SECURING.md` covers putting it behind Tailscale, Cloudflare Access or an
authenticating proxy, instead of a login of its own.

Preparing the repository to go public: no secrets in 68 commits of history
(gitleaks, plus the real `CREDENTIALS_KEY` searched for directly); host-specific
notes moved out; README, SECURITY, CONTRIBUTING, CHANGELOG, issue templates; CI
and multi-arch releases to GHCR; the logo; a test that had started failing on
its own because its clock was fixed in August; and seven UI fixes found by using
a fresh demo instance as a stranger would. The UI now takes its colours from
the logo, by meaning: graphite `primary`, red `brand` for the mark and the main
action only, blue `info` for work in progress, `destructive` for failure. Red as
primary was tried first and made every running job look broken.

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

## The maintainer's standing instructions

- **Do the work; don't ask for authorisation.** Report what needs review.
- **Everything in English** — code, comments, docs, UI.
- **Spanish when talking to Santi.**
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
