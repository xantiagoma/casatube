# Deploying CasaTube

One image. The app, **yt-dlp** and **ffmpeg** are inside it; nothing is expected
from the host (PLAN §14). It runs the same way on plain Docker, Docker Compose
and CasaOS.

- [Quick start](#quick-start)
- [Building the image — and the tag](#building-the-image--and-the-tag)
- [Environment variables](#environment-variables)
- [Volumes](#volumes)
- [A library on a network mount](#a-library-on-a-network-mount)
- [Updating yt-dlp](#updating-yt-dlp)
- [Health](#health)
- [What is inside](#what-is-inside)
- [Troubleshooting](#troubleshooting)

---

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/xantiagoma/casatube && cd casatube
docker compose up -d
docker compose logs -f
```

Then open <http://localhost:8520>.

`docker-compose.yml` reads its settings from the environment, so a `.env` next
to it is the whole configuration:

```dotenv
# .env
CASATUBE_VERSION=0.1.0
YTDLP_VERSION=2026.08.19

PUID=1000
PGID=1000
UMASK=022
TZ=America/Bogota

CASATUBE_PORT=8520
CASATUBE_DATA=./data
CASATUBE_LIBRARY=/mnt/media/youtube
MAX_CONCURRENT_DOWNLOADS=3

# Without this, every cookie and password you add is stored in plain text.
# Generate with: openssl rand -base64 48
CREDENTIALS_KEY=change-me-to-a-long-random-string
```

⚠️ **`.env` now holds a secret**, so it belongs beside the compose file and
nowhere else — not in the repository, and not in the backup that gets emailed
around. `.gitignore` already covers it.

### Plain Docker

```bash
docker run -d \
  --name casatube \
  --restart unless-stopped \
  -p 8520:8520 \
  -e PUID=1000 -e PGID=1000 -e UMASK=022 -e TZ=America/Bogota \
  -e CREDENTIALS_KEY="$(openssl rand -base64 48)" \
  -v /srv/casatube:/data \
  -v /mnt/media/youtube:/library \
  casatube:0.1.0-ytdlp-2026.08.19
```

### CasaOS

CasaOS installs from a Compose file: **App Store → Custom Install → Import**,
paste `docker-compose.yml`, and adjust the volume paths and `PUID`/`PGID`. From
a shell it is `casaos-cli app-management install -f <compose>`, and an
`x-casaos:` block in the file supplies the menu entry — title, icon, category,
`port_map` and `index: /`.

Three things to set so it behaves like the rest of a CasaOS box:

- **`PUID`/`PGID` must match whatever owns the library** — usually `1000:1000`,
  the same values `transmission` and `metube` use. ⚠️ Not always the deciding
  factor: where the library is reached over rclone or SSHFS, the *remote* login
  owns the files and `UMASK` is what decides whether the media server can read
  them.
- **Point the library at the same share the media server reads**, not at a
  private CasaOS volume, or nothing will ever see the downloads.
- **`pull_policy: missing`**, for an image built on the box. Without it CasaOS
  tries to pull `casatube:latest`, which exists in no registry, and the install
  fails on an image that is already there.

🔴 **Once CasaOS manages the app, stop using `docker run` and `docker compose`
on it.** Recreating the container by hand leaves CasaOS's record pointing at a
container that no longer exists, and the menu entry stops matching the thing
that is running. Redeploy through CasaOS instead:

```bash
docker build --build-arg YTDLP_VERSION=2026.08.19 -t casatube:latest .
casaos-cli app-management apply -f <your-compose>
./scripts/smoke.sh
```

⚠️ **A library on a FUSE mount: bind the parent, not the mount.** Where the
library is an rclone or SSHFS mount, mounting *it* into the container captures
the FUSE handle that existed at start — and the moment rclone remounts, the
container is looking at a stale one and the library reads as empty. Bind the
directory **above** it with `propagation: rshared` and point `LIBRARY_DIR`
inside:

```yaml
volumes:
  - type: bind
    source: /mnt/mailmedia          # the parent, not /mnt/mailmedia/videos
    target: /mnt/mailmedia
    bind: { propagation: rshared }
environment:
  LIBRARY_DIR: /mnt/mailmedia/videos
```

📌 The image declares `EXPOSE 8520` and `VOLUME /data`, so CasaOS picks up the
port and the data mount on its own. **`/library` is deliberately not declared** —
with `LIBRARY_DIR` pointing somewhere else entirely, as it does above, a
`VOLUME /library` makes Docker create a fresh anonymous volume on every
recreate. Six of them accumulated before anybody looked.

---

## Building the image — and the tag

```bash
docker build --build-arg YTDLP_VERSION=2026.08.19 \
  -t casatube:0.1.0-ytdlp-2026.08.19 .
```

### Why the tag carries a yt-dlp date

**yt-dlp breaks when sites change.** A tag that names only the app version
(`casatube:0.1.0`) says nothing about the part that actually rots, and rebuilding
"the same version" six months later silently ships a yt-dlp that YouTube stopped
answering. So the tag names both, and the yt-dlp half is the release date —
which is what a yt-dlp version *is*:

```
casatube:0.1.0-ytdlp-2026.08.19
         ▲     ▲
         │     └── the yt-dlp release that is baked in (its version is its date)
         └──────── the app version, from package.json
```

Upstream HomeTube tags the same way (`hometube:v2.10.0-yt-dlp-2026.08.19`), for
the same reason.

### Building the tag

Both halves come from a source of truth, never from memory:

```bash
APP_VERSION=$(bun -e 'console.log(require("./package.json").version)')
YTDLP_VERSION=$(curl -fsSL https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest \
                | grep -m1 '"tag_name"' | cut -d'"' -f4)

docker build \
  --build-arg YTDLP_VERSION="$YTDLP_VERSION" \
  -t "casatube:${APP_VERSION}-ytdlp-${YTDLP_VERSION}" \
  -t "casatube:${APP_VERSION}" \
  -t casatube:latest \
  .
```

`casatube:0.1.0-ytdlp-2026.08.19` is the **immutable** tag: it is never rebuilt
onto different content. `casatube:0.1.0` and `casatube:latest` are moving
pointers for convenience. Deploy the immutable one.

The build **fails** if the downloaded binary does not report the version that
was asked for, so a typo in `YTDLP_VERSION` cannot become a mystery at 3am.

The version is also readable from the image without starting it:

```bash
docker image inspect casatube:0.1.0-ytdlp-2026.08.19 \
  --format '{{index .Config.Labels "io.casatube.ytdlp.version"}}'
```

### Multi-architecture

The Dockerfile picks the right yt-dlp build from `TARGETARCH`, so `amd64` and
`arm64` both work:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg YTDLP_VERSION=2026.08.19 \
  -t casatube:0.1.0-ytdlp-2026.08.19 --push .
```

> Only `linux/amd64` has been built and run so far. `arm64` selects
> `yt-dlp_musllinux_aarch64`, which exists in the same release, but it has not
> been exercised.

---

## Environment variables

Everything is configured this way, so the image is the only artefact (PLAN §12).

### Identity and permissions

| Variable | Default | What it does |
|---|---|---|
| `PUID` | `1000` | uid the app runs as, and the owner of everything it writes |
| `PGID` | `1000` | gid, same |
| `UMASK` | `022` | Permission mask for new files (`022` → `rw-r--r--`, `002` → `rw-rw-r--`) |
| `TZ` | `Etc/UTC` | Container timezone. Set it, or every timestamp in the log is UTC |

⚠️ **This is the setting that decides whether downloads are playable.** Files
written to the library must be readable by the media server; get it wrong and
you get downloads that exist and cannot be played. `PUID`/`PGID`/`UMASK` is the
linuxserver.io convention, which is what the rest of a typical deployment
(`transmission`, `metube`) already uses — see PLAN §15.

Use `UMASK=002` when the library is shared with a media server running under a
*different* user but the *same* group.

### Paths

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `/data` | Both SQLite databases, temp downloads, yt-dlp's config and cache. **One volume** |
| `TEMP_DIR` | `/data/tmp` | Downloads land here first, then move to the library |
| `LIBRARY_DIR` | `/library` | Destination root. Often a network mount |

Change the **volume mappings**, not these — the paths inside the container are
what the image expects.

`TEMP_DIR` is worth moving only if you want partial downloads on a different
disk from the databases. If you do, mount it and give it its own space:
a destination that stays down for a week must not quietly fill the data volume.

### Behaviour

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8520` | HTTP port inside the container |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Concurrent downloads. Limits the download stage only (PLAN §17) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Download defaults

What a job gets when nothing else says otherwise: the form's starting point, a
watched source, an API call that sends no preferences. Every one of them is also
on **Settings → Download defaults**, where a saved value beats the variable and
takes effect immediately — no restart.

| Variable | Default | What it does |
|---|---|---|
| `DEFAULT_MAX_RESOLUTION` | `1080` | Ceiling, not a target |
| `DEFAULT_VIDEO_CODEC` | `auto` | `auto`, `efficient`, or a named codec. A preselection, never a silent swap |
| `DEFAULT_ORIGINAL_ONLY` | `true` | Exactly one audio track: the one marked original |
| `DEFAULT_AUDIO_LANGUAGES` | *(empty)* | Comma-separated tags |
| `DEFAULT_SUBTITLE_LANGUAGES` | `en` | ⚠️ Independent of audio (R7). Never derived from it |
| `DEFAULT_AUTOMATIC_SUBTITLES` | `true` | Whether machine-generated captions count — see below |
| `DEFAULT_EMBED_SUBTITLES` | `false` | Off writes sidecars, which every media server reads |
| `DEFAULT_SPONSORBLOCK` | `true` | Mark or remove sponsor segments where the provider supports it |

⚠️ **`DEFAULT_AUTOMATIC_SUBTITLES=false` removes a language rather than
downgrading it.** Authored subtitles always win where a language has both; this
decides what happens where it has *only* machine captions. On, it takes them —
something is better than nothing. Off, that language gets nothing at all, which
is the honest answer for anyone who would rather have no subtitle than a
transcription full of guesses, because a bad `.srt` beside the video looks
exactly like a real subtitle to every media server that finds it.

### Credentials at rest

Cookies, logins and API keys are added from **Settings → Credentials**, per
site, and stored in `DATA_DIR/casatube.db`. `CREDENTIALS_KEY` is what decides
whether they are stored *encrypted* or *readable*.

| Variable | Default | What it does |
|---|---|---|
| `CREDENTIALS_KEY` | **unset — secrets stored in plain text** | Passphrase for AES-256-GCM at rest. The key is derived with PBKDF2-HMAC-SHA256, 210 000 iterations, a fresh random salt per credential |

```bash
openssl rand -base64 48        # generate one; put it in .env, or the unit file
```

🔴 **Unset means plain text, and everything says so.** There is no weaker
encryption and no obfuscation: the secret goes into the row as it was typed.
The server prints three lines at every start, every write logs one, every
listing carries the reason, and the Settings screen shows a red *"Not
encrypted"* panel **instead of** the "encrypted at rest" claim — that sentence
is only ever drawn when it is true. Nothing about this is quiet; the only way
to end up storing cookies in the clear is to decide to.

⚠️ **Changing the key re-encrypts nothing.** Each credential records which key
sealed it (a short non-reversible fingerprint, shown on the row), so after a
change the old rows simply cannot be opened. That state is diagnosable rather
than mysterious: the **Test** button on the row says it was sealed with a
different key, and the fix is to paste that credential in again. There is no
re-encrypt-everything command.

📌 **Losing the key loses the credentials and nothing else.** They are copies
of secrets that exist elsewhere — a browser session, a password manager — so
the recovery is to export the cookies again. Jobs, history and the library are
untouched by any of this.

⚠️ **The key is not in `DATA_DIR`**, deliberately, so the volume that gets
backed up does not carry the thing that opens it. That also means restoring
`/data` onto a host with a different `CREDENTIALS_KEY` restores credentials
that cannot be read — copy the key across too, or expect to paste them again.

### Browser playback (on-demand HLS)

No browser opens Matroska, so an MKV is remuxed to HLS when someone presses
play. **The video is copied, never re-encoded** — only the audio is converted,
and only when it has to be — so this costs a few percent of one core, not a
transcode. A file a browser already plays (MP4 of H.264 and AAC) is served
straight from `GET /api/library/file` and none of this happens.

⚠️ **It writes real bytes to `TEMP_DIR`.** The 67 MB music video below leaves
71 MB of segments; a film leaves several hundred. `GET /api/library/hls/sessions`
reports what is in use. The directory is wiped on every start, so a crash cannot
leave segments behind for ever.

| Variable | Default | What it does |
|---|---|---|
| `HLS_SEGMENT_SECONDS` | `6` | Target segment length. ⚠️ Approximate — with the video copied, cuts land on keyframes, so real segments vary (3–10 s is normal) |
| `HLS_MAX_SESSIONS` | `3` | Concurrent remuxes. Over the cap, a finished session is evicted; if all are busy the request gets a retryable 503 |
| `HLS_IDLE_MS` | `3600000` | A **finished** session with nobody reading it is removed after this. This is disk |
| `HLS_TRANSCODE_IDLE_MS` | `300000` | A session **still remuxing** with nobody reading it is killed after this. This is CPU: it means the tab was closed |
| `FFMPEG_BIN` | `ffmpeg` | Both are in the image; set these only to point at a specific build. Also reaches yt-dlp as `--ffmpeg-location` — see below |
| `FFPROBE_BIN` | `ffprobe` | Used for the "can a browser already play this?" verdict, cached per file |

**`FFMPEG_BIN` is resolved before it is forwarded.** yt-dlp does not consult
`PATH` for `--ffmpeg-location`, and answers a location that does not exist with
a *warning* — `Continuing without ffmpeg` — after which the merge fails and the
thumbnail stays WebP. So a bare name is looked up on `PATH` here and an absolute
path is required to exist; anything that resolves to neither is **not forwarded
at all**, leaving yt-dlp's own lookup untouched. The boot log says which of the
three happened:

```
[casatube] ffmpeg yt-dlp will use /usr/bin/ffmpeg
[casatube] ffmpeg yt-dlp will use /opt/ff/ffmpeg, but there is no ffprobe beside it — …
[casatube] ffmpeg FFMPEG_BIN is set to /opt/typo/ffmpeg, which does not resolve to an existing path — …
```

⚠️ The middle line is worth reading twice. Given a *file*, yt-dlp keeps it as
ffmpeg and builds every other program's path as `dirname/<program>` — so
pointing `FFMPEG_BIN` at a lone binary takes **ffprobe** away from yt-dlp even
though `PATH` has one. Point it at a directory holding both, or at a build that
ships both side by side.

### Thumbnails

The picture on a library card comes from one of two places. The **provider's
own** image is downloaded with the video and lands beside it as `Name.jpg` —
that is library content, it is what media servers read, and it is always
preferred. Anything with no sidecar gets **one frame from ffmpeg**, taken at 10%
of the duration (not second 0, which on a great many videos is black), and
cached in `DATA_DIR/thumbnails`.

⚠️ **Listing the library generates nothing.** A frame is produced only when
`GET /api/library/thumbnail?path=…` is called for that file, so opening a screen
of two hundred cards cannot become two hundred ffmpeg processes.

📌 The cache is derived data: deleting `DATA_DIR/thumbnails` is always safe, and
it refills itself. Nothing generated is ever written into the library.

| Variable | Default | What it does |
|---|---|---|
| `THUMBNAIL_WIDTH` | `480` | Width of a generated frame. Never upscales a smaller video |
| `THUMBNAIL_MAX_CONCURRENT` | `2` | ffmpeg processes at once. Requests over the cap wait |
| `THUMBNAIL_TIMEOUT_MS` | `20000` | Per generation, after which the process is **killed** and the request answers |
| `THUMBNAIL_MAX_ENTRIES` | `5000` | Cached frames kept before the oldest are pruned |

### Filenames, and what happens when one is taken

A download is saved as its cleaned title — or as whatever you type into **Save
as** in the download panel, which is checked against the destination folder
while you type and shows what is already using that name.

🔴 **Nothing is ever overwritten.** A name already in use lands as
`Name (2).mkv` and the job log says so. The two readings of a collision are "I
am downloading this again" and "these are two different videos that clean down
to one title", and only the first is safe to guess — so it is never guessed.

⚠️ A name is taken by its **sidecars** too. `Name.mkv`, `Name.en.srt` and
`Name.jpg` are one thing with one name, so a folder holding a lone
`Name.en.srt` will not accept a new `Name.mkv` — that would silently adopt
somebody else's subtitles. Sidecars follow the final name, suffix included.

📌 To replace on purpose, choose **Replace it** in the panel, or use
*Re-download* on a finished job — which is what that button means and why it is
the one place `replace` is the default. The file it replaces goes to `.trash/`,
where it stays restorable for the retention window; nothing is deleted.

### Subtitles and audio tracks in the player

**Subtitles.** Sidecars are served through `GET /api/library/subtitle`, which
converts SubRip to WebVTT on the way out — a `<track>` element takes nothing
else, and a `.srt` handed over as itself is dropped by the browser in silence.
`.ass` and `.ssa` answer 415 instead: they carry positioning, fonts and drawing
commands WebVTT cannot express, so a converted one would be a worse subtitle
wearing the same name. They remain downloadable.

⚠️ No track switches itself on. A file with two languages has not told anyone
which one to read, so the captions button and the menu beside it are where the
choice is made.

**Audio.** A file with several audio tracks plays through HLS, and the remux
carries **one** of them. `GET /api/library/hls/index.m3u8?path=…&audio=N` picks
which — `N` counts among the audio streams, so `0` is the first — and the
player's *Audio track* selector is that parameter.

📌 Each choice is its own remux and its own session, so switching starts ffmpeg
again from the beginning of the file; playback resumes where it was. Sessions
are still capped by `HLS_MAX_SESSIONS`, and two tracks of one film are two of
them.

### Notifications

Notifications are rows, because one that fires while the tab is closed is still
a notification. A sweep runs **every six hours** and re-reads both values each
time, so a change on the Settings screen needs no restart.

| Variable | Default | What it does |
|---|---|---|
| `NOTIFICATION_RETENTION_DAYS` | `30` | **Read** notifications older than this are removed. `0` keeps them for ever |
| `NOTIFICATION_MAX_ENTRIES` | `5000` | Ceiling on the table. `0` removes the ceiling |

⚠️ The two rules are not redundant, and it is worth knowing which one does the
work. The age rule **never touches an unread notification** — that is what makes
it safe to run unattended — so on a bell nobody opens it removes nothing and the
table grows without limit. The ceiling is what actually bounds it.

📌 So the ceiling is the one thing here that can remove something nobody has
read. It spends read notifications first, oldest first, and reaches unread ones
only when there is nothing else left; when it does, the log says so:

```
[casatube] notifications removed 12 over the cap, ⚠️ 3 of them never read
```

If that line appears and you did not want it to, raise `NOTIFICATION_MAX_ENTRIES`
— the fix is a bigger ceiling, not a longer retention.

### yt-dlp

| Variable | Default | What it does |
|---|---|---|
| `YTDLP_AUTO_UPDATE` | `false` | Run `yt-dlp -U` on every container start |
| `YTDLP_BIN` | `/opt/yt-dlp/yt-dlp` | Which yt-dlp runs. Point it into `/data` to make updates survive — see below |
| `CASATUBE_YTDLP_PINNED_VERSION` | *(set by the build)* | The version the image ships. Read-only; do not set it |

### Optional integrations

| Variable | Default | What it does |
|---|---|---|
| `COOKIES_FILE` | unset | Netscape-format cookie jar for age-gated / members-only / bot-challenged content |
| `MEDIA_SERVER_URL` | unset | Called to refresh the library after a job completes |
| `MEDIA_SERVER_TOKEN` | unset | Token for the call above |

⚠️ **Cookies are credentials.** Keep the file inside `DATA_DIR` with `chmod 600`,
never in the repository. They expire within hours, and reusing them from a
different IP than the one that created them is itself a signal to the site — a
mitigation, not a fix (PLAN §12).

📌 **`COOKIES_FILE` is the global fallback — one jar for every site.** Per-site
cookies, per-site logins and API keys are added from **Settings → Credentials**
and resolve most-specific-first (`www.youtube.com` beats `*.youtube.com` beats
`youtube.com` beats `*`); anything that matches there beats this file. Those are
stored in the database and encrypted only when `CREDENTIALS_KEY` is set — see
[Credentials at rest](#credentials-at-rest).

---

## Volumes

| Mount | Contents | Backup |
|---|---|---|
| `/data` | `casatube.db`, `queue.db`, `tmp/`, `.config/`, `.cache/` | **Yes — this directory is the backup** |
| `/library` | Finished downloads, in the layout you chose | Your existing media backup |

There are **two** SQLite files under `/data` by decision (PLAN §9): the app's
and the queue's. One volume still holds both, and copying the directory still
backs both up.

**CasaTube does not back itself up.** Copying `/data` is the backup. Settings
offers an *export* of the databases as a file, which covers "I want a copy
before I upgrade" without pretending to be a backup system (PLAN §15).

Stop the container before copying `/data`, or copy the WAL files
(`*.db-wal`, `*.db-shm`) along with the databases — a `casatube.db` snapshot
taken alone while the app is writing is not a consistent database.

⚠️ **`casatube.db` holds the credentials**, so a copy of `/data` is a copy of
your cookies and logins. Encrypted if `CREDENTIALS_KEY` is set — and readable
if it is not, which is the other reason to set it. The key itself is *not* in
`/data`: restoring this directory somewhere with a different key restores
credentials nobody can open (see [Credentials at rest](#credentials-at-rest)).

---

## A library on a network mount

The library is usually not local, and that changes two things.

### Prefer mounting on the host

Mount the share on the host and bind-mount it into the container:

```yaml
volumes:
  - /mnt/media/youtube:/library
```

```fstab
# /etc/fstab
192.168.1.10:/export/media  /mnt/media  nfs4  rw,soft,timeo=100,retrans=3,_netdev  0 0
```

A host mount is visible to `df`, survives `docker compose down && up`, and fails
in one obvious place instead of inside a container that will not start.

If you would rather Compose own the mount, `docker-compose.yml` carries a
commented `driver_opts` block for NFS.

### Use `soft`, with a timeout

⚠️ **A dead mount does not fail — it hangs.** This is not hypothetical: on the
reference deployment, reading 1 MB from a broken mount returned 0 bytes after
19 seconds rather than erroring, and a media manager sat in `importPending`
indefinitely (PLAN §15 § Timeouts).

CasaTube puts deadlines on every operation that touches the library. `soft`
plus `timeo`/`retrans` on the mount is the other half of that; a `hard` mount
will wait forever regardless of what the app asks for.

### The library is not chowned

The entrypoint fixes ownership inside `/data`, and **deliberately does not touch
`/library`**: a recursive chown across a network mount is slow, often not
permitted, and would rewrite the ownership of files CasaTube never created.

It checks instead, and says so on startup:

```
casatube-entrypoint: WARNING: /library is not writable by 1000:1000 — check the export's ownership, not just the mount
```

If you see that line, fix the export's ownership or `PUID`/`PGID` — a mount that
is present but unwritable produces jobs that download 800 MB and then cannot
finish.

### When the destination is gone at the worst moment

The default is to **keep the file in `TEMP_DIR`** and hold the job in
`waiting-for-destination`, retrying the move on a schedule (PLAN §15). Nothing
is discarded. That is why `TEMP_DIR` needs real space on the data volume, and
why a destination that stays down should raise an alert rather than silently
accumulate.

---

## Updating yt-dlp

yt-dlp breaks when sites change. Waiting for a CasaTube release to fix a YouTube
change would be absurd, so the binary can be updated without rebuilding.

**Verified:** `yt-dlp -U` self-updates inside a running container. The shipped
binary is the official standalone release build, which replaces itself in place.
(It has to be that build: `yt-dlp -U` *refuses* to run on a pip/wheel install.)

```
Current version: stable@2026.07.04 from yt-dlp/yt-dlp
Latest version: stable@2026.08.19 from yt-dlp/yt-dlp
Updating to stable@2026.08.19 from yt-dlp/yt-dlp ...
Updated yt-dlp to stable@2026.08.19 from yt-dlp/yt-dlp
```

Three ways to trigger it:

| | How | Notes |
|---|---|---|
| **On demand** | Settings → *check and update yt-dlp* | Runs the same `-U` |
| **On start** | `YTDLP_AUTO_UPDATE=true` | Adds a ~40 MB download to every start, and every start becomes a version change you did not review |
| **Rebuild** | New image with a new `YTDLP_VERSION` | The version is in the tag, so what runs is what the tag says |

### ⚠️ The update does not survive re-creating the container

By default yt-dlp lives **inside the image**, at `/opt/yt-dlp/yt-dlp`. A
self-update rewrites that file in the container's writable layer — which
`docker compose up --force-recreate`, `docker compose pull` or a `docker rm`
throws away. The container comes back on the version the tag names.

That is a real trade-off, and there are exactly two positions. Both are
verified:

**Option A — keep yt-dlp in the image (default).**

```yaml
YTDLP_BIN: /opt/yt-dlp/yt-dlp    # the default; nothing to set
```

- ✅ **Predictable.** The tag is the truth: the same tag always starts on the
  same yt-dlp, on any host, after any recreate.
- ✅ A bad yt-dlp release is undone by restarting the container.
- ❌ An update you made at 3am to unbreak YouTube is **lost** on the next
  `docker compose pull`. You will fix it twice.

**Option B — keep yt-dlp in the data volume.**

```yaml
YTDLP_BIN: /data/bin/yt-dlp
```

The entrypoint seeds it from the pinned copy on first start, so nothing extra to
install.

- ✅ **Updates survive** a recreate, a `pull`, and an app upgrade.
- ❌ The tag no longer tells you which yt-dlp is running — the volume does.
  Two hosts on the same tag can behave differently, and that is a hard bug to
  see.
- ❌ Rolling back means deleting the file, not changing the tag.

**The default is A**, because "the tag is the truth" is worth more than saving
one manual update, and because the recovery from a stale yt-dlp is a rebuild you
were going to do anyway. Choose B when the box is far away and unbreaking
YouTube at 3am matters more than knowing exactly what is running.

### Checking, and going back

```bash
# what is actually running, and what the image pinned
docker exec casatube yt-dlp --version
docker exec casatube printenv CASATUBE_YTDLP_PINNED_VERSION

# update now, without a restart
docker exec casatube yt-dlp -U

# back to the version the image shipped (option A)
docker exec casatube sh -c 'cp /opt/yt-dlp/yt-dlp.pinned /opt/yt-dlp/yt-dlp.new \
  && mv -f /opt/yt-dlp/yt-dlp.new /opt/yt-dlp/yt-dlp'
docker restart casatube

# back to the version the image shipped (option B)
docker exec casatube rm -f /data/bin/yt-dlp   # re-seeded on the next start
docker restart casatube
```

`/opt/yt-dlp/yt-dlp.pinned` is never written to — it is the known-good copy the
entrypoint seeds from, which is what makes "go back" a one-liner rather than a
re-pull.

⚠️ Copy to a temporary name and `mv` it into place, as above. Writing directly
over a binary that is running fails with *text file busy*.

### Running with `--user`

A container started with `--user` (instead of `PUID`/`PGID`) cannot write to
`/opt`, so yt-dlp falls back to the read-only pinned binary and self-update is
disabled. The startup log says so. Set `YTDLP_BIN=/data/bin/yt-dlp` to get
updates back.

---

## Health

The image ships a `HEALTHCHECK` that asks the server whether it is answering:

```bash
docker inspect --format '{{.State.Health.Status}}' casatube
# healthy
```

- It requests `/api/health` on `PORT`, inside the container, every 30 s.
- **A refused connection, a timeout or a 5xx is unhealthy.** Any other reply
  means the server is up and serving, and counts as healthy.
- `start_period` is 30 s: migrations run, the queue recovers whatever the last
  run left in flight, and the browser bundle is built once — all before the
  first request is served. A container that is still starting is not sick.
- `HEALTHCHECK_PATH` overrides the path if you ever need it to check something
  else.

Run it by hand to see why it failed:

```bash
docker exec casatube /usr/local/bin/casatube-healthcheck; echo "exit=$?"
```

---

## What is inside

Multi-stage build; the runtime stage is plain Alpine, so the Bun toolchain, the
build cache and the dev dependencies never ship.

| | |
|---|---|
| **Size** | **292 MB** on disk, **133 MB** to pull (compressed) |
| Base | `alpine:3.22.5` |
| Runtime | Bun 1.4.0 (the binary only, copied from `oven/bun:1.4-alpine`) |
| Downloader | yt-dlp 2026.08.19 — official standalone musllinux build |
| Media | ffmpeg / ffprobe 6.1.2 from the Alpine repository — the real thing, 222 encoders and 186 muxers |
| Frontend | Bundled at startup by `Bun.build` and held in memory — no build step, no `dist/` to go stale |
| PID 1 | `tini`, so `SIGTERM` reaches the app and cancelled yt-dlp/ffmpeg children are reaped |
| Privilege drop | `su-exec`, after the entrypoint has fixed ownership |

Where the size goes: ffmpeg and its codec libraries 133 MB, the Bun binary
74 MB, yt-dlp 40 MB, `node_modules` 49 MB, Alpine 9 MB, the app itself under
1 MB. For comparison, on the same host `metube` is 490 MB and `hometube` 806 MB
by the same measure.

> `docker image ls` on Docker 29 reports **DISK USAGE** (~439 MB), which counts
> both the unpacked snapshot and the compressed blobs. **CONTENT SIZE** (133 MB)
> is what a `docker pull` transfers.

The runtime image deliberately drops `typescript`, `@typescript/*`, `@types/*`
and `bun-types` after the production install. Bun auto-installs peer
dependencies, and Elysia and drizzle-orm peer on the TypeScript toolchain —
`typescript` 7 alone drags in a ~27 MB native compiler. None of it is imported
at runtime; types are erased at transpile time.

---

## Troubleshooting

### Downloads exist but the media server will not play them

Permissions, nearly always. Check what was actually written:

```bash
ls -l /mnt/media/youtube
```

Then match `PUID`/`PGID` to the owner the media server expects, and set
`UMASK=002` if it runs as a different user in the same group. Files already
written keep their old ownership — fix those by hand once.

### `WARNING: /library is not writable by 1000:1000`

The mount is there but the app cannot write to it. Check the *export's*
ownership, not just that the mount succeeded — an NFS export with
`root_squash` and a directory owned by a different uid mounts perfectly and
still refuses writes.

### The container is `unhealthy`

```bash
docker logs casatube --tail 50
docker exec casatube /usr/local/bin/casatube-healthcheck; echo "exit=$?"
```

`no HTTP response` means the process is not listening — look at the logs for a
failed migration or a database it could not open. A 5xx means it is listening
and unhappy.

### A YouTube change broke downloads

```bash
docker exec casatube yt-dlp -U && docker restart casatube
```

Then rebuild with the new `YTDLP_VERSION` so the tag matches reality again —
otherwise the fix disappears on the next recreate (see
[Updating yt-dlp](#updating-yt-dlp)).

### `Sign in to confirm you're not a bot`

The IP looks suspicious to YouTube. Export cookies from a logged-in browser
session and paste (or upload) the `cookies.txt` in **Settings → Credentials**,
filed under `youtube.com`. The file is validated at the paste — a jar whose tabs
were turned into spaces by a terminal or a chat window is refused there and
then, naming the line, rather than failing twenty minutes into an 800 MB
download — and the **Test** button says whether it has already expired and
whether its domains actually cover the site.

The older way still works and is global rather than per site: put the file
inside `/data`, `chmod 600` it, and set `COOKIES_FILE=/data/cookies.txt`.

⚠️ Set `CREDENTIALS_KEY` **before** adding the first credential, or the jar is
written to the database in plain text (the screen will say so). See
[Credentials at rest](#credentials-at-rest).

Expect to redo it either way: cookies expire within hours, and using them from a
different IP than the one that created them is itself a signal.

### Ownership changed and now everything is wrong

Changing `PUID`/`PGID` makes the entrypoint chown `/data` recursively on the
next start, once, and log it:

```
casatube-entrypoint: taking ownership of /data (1000:1000 -> 1001:1001)
```

`/library` is never chowned — that is on purpose (see
[A library on a network mount](#a-library-on-a-network-mount)).
