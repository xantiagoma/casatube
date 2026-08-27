# Worklog

Where the work is, so it can be picked up by anyone — including a future
session with none of this context. Newest first.

---

## 2026-08-27 — The library has pictures, and the good ones come from the source

> «la biblioteca no tiene miniaturas.»

The grid drew a grey icon for everything. The pictures visible *before* a
download are remote YouTube URLs that arrive with the probe; the moment the file
was on disk, nobody kept anything.

Now there are **two sources, in a fixed order**, and the order is the design.

**561 tests, 0 failures** (was 516; +45). `tsc` clean.

### 1. The provider's picture, as a sidecar — the preferred one

`--write-thumbnail --convert-thumbnails jpg` on every fetch, and the file moves
into the library with the video: `Me at the zoo.jpg` beside `Me at the zoo.mp4`,
the same way subtitles already travelled.

🔴 **It is preferred because it was *chosen*.** The creator's cover, or the frame
the site picked, beats a frame we pull out of the middle of the file — and
`Name.jpg` is the convention Jellyfin, Plex and Emby already read, so one small
file buys a poster everywhere rather than only inside CasaTube.

⚠️ `--convert-thumbnails jpg` is the load-bearing half: YouTube serves **WebP**,
which several media servers ignore. See `docs/DISCOVERIES.md` for what happens
when ffmpeg is not on `PATH` — the conversion fails quietly and the `.webp`
stays, which is why the collector accepts all four formats instead of insisting.

⚠️ The image arrives *first*, like subtitles do, so it is excluded from the byte
budget. Counted, it would drive the progress bar to 100% before the video began
— the trap `--write-subs` already taught us, from a second direction.

### 2. A frame from ffmpeg — derived, and therefore not library content

Everything with no sidecar — old downloads, files copied in by hand, providers
that publish no image — gets one frame, cached under
`DATA_DIR/thumbnails/<key>.jpg`.

🔴 **These never go into the library.** A generated frame is not content: it can
be deleted without losing anything, and writing it next to the video would mean
a file nobody downloaded appearing in the grid, in the backups, and on the NAS.

⚠️ **Not second 0.** An enormous number of videos open on a fade from black or a
title card, so the obvious offset is the one most likely to be useless. The
frame is taken at **10% of the duration**, floored at one second and kept half a
second clear of the end — verified on the real 19-second MP4, which answers at
1.9 s with a recognisable picture.

📌 The cache key is `(path, size, mtime, width)` and **the key is the
filename** — the same rule `core/hls.ts` follows for its playback verdict. A
re-download over the same name is a different video, and an entry keyed on the
path would go on serving a picture of the old one. Because the key is the name,
a stale entry is never *found*, so nothing has to notice that it is stale.

### The route

`GET /api/library/thumbnail?path=` — sidecar, else cache, else generate.

| | |
|---|---|
| `200` | an image, `ETag` + `cache-control: private, max-age=3600`, and `x-thumbnail-source: sidecar\|cache\|generated` |
| `304` | the browser already has this exact picture |
| `404` | there is none and none can be made — **not an error**, the grid draws its grey rectangle |
| `400` / `503` / `504` | the path left the root, the mount is down, the mount hangs |

⚠️ **Every failure has an empty body**, like the HLS segment route: this URL goes
in an `<img src>`, and a browser handed JSON where it expected an image reports
nothing useful. The status code is the whole message.

### The limits, because this spawns processes on a shared box

- 🔴 **Listing generates nothing.** Two hundred cards would be two hundred
  ffmpegs; generation happens only when a *thumbnail* is asked for. There is a
  test that asserts the process count is zero after a listing.
- **Two ffmpegs at once**, and ten simultaneous requests for one file are **one**
  process — the in-flight map is what makes a scroll cheap.
- **A deadline, and a kill.** 20 s, after which the process is killed and the
  request answers `Timeout`.
- **Failures are remembered for five minutes**, keyed on the cache key. Without
  it a corrupt file in a folder of two hundred is two subprocesses per card per
  scroll, for ever.
- **The output is renamed into place**, never served while it is being written —
  and a killed run leaves nothing a later request could mistake for a valid entry.
- **The cache is pruned** at 5 000 entries, oldest first.

### `.jpg` files stopped being library items

`core/library.ts` now attaches an image to the media file that shares its base
name, exactly as it does a subtitle, and reports it as `item.thumbnail`.
Without that, downloading a poster would add a **second card** to the grid for a
file nobody asked for. An image that belongs to nothing stays an item — a stray
picture is still something to see and delete.

### Measured, against the real file

Downloaded `Me at the zoo` through the API on a server started for the purpose:

| | |
|---|---|
| `Videos/Me at the zoo.jpg` beside the MP4 | 23 689 bytes, JPEG 480×360, converted from WebP |
| Sidecar request | `200`, `x-thumbnail-source: sidecar`, magic bytes `ff d8` |
| Same request with `If-None-Match` | `304`, no body |
| With the sidecar moved away, cold | `200`, `generated`, **61 ms**, 320×240 — not upscaled |
| Second request | `200`, `cache`, **8 ms**, byte-identical |
| Sidecar put back | `sidecar` again, cache untouched |
| A file that is not there | `404`, zero bytes |
| `?path=../../etc/passwd` | `400` |
| After listing the library | `DATA_DIR/thumbnails` **does not exist** |

### `src/web`, not touched

Another agent owns that folder this session. The frontend needs one change:
point the card's `<img src>` at
`/api/library/thumbnail?path=${encodeURIComponent(item.path)}`, with `onError`
falling back to the grey icon it already draws — a 404 is the normal answer for
a file with no picture, not a fault.

---

## 2026-08-27 — MKVs play in the browser, and you can jump to minute three

> «los MKV no se reproducen… y avanzar en el vídeo me importa.»

The library is full of MKVs, because that is what yt-dlp writes when it merges
video and audio. No browser opens Matroska, and the audio inside is usually
Opus, which Safari — the only browser on the iPad this is watched from — does
not decode even in a container it accepts. So the Library screen offered a
download and nothing else.

Now there is **on-demand HLS**: the H.264 stream is *copied* into MPEG-TS
segments, only the audio is converted, and the playlist keeps every segment so
you can jump forwards **and back**.

**511 tests, 0 failures** (was 450; +61). `tsc` clean.

### What was built

| Where | What |
|---|---|
| `src/core/hls.ts` | The verdict, the ffmpeg command, sessions, limits, cleanup |
| `src/api/hls.ts` | `/api/library/hls/{playback,index.m3u8,:segment,sessions}` |
| `src/core/errors.ts` | `TranscodeUnavailable` (422), `TranscodeBusy` (503) |
| `src/api/config.ts` | `FFMPEG_BIN`, `FFPROBE_BIN`, `HLS_*` |

### The decision that costs nothing: asking first

`GET /api/library/hls/playback?path=` answers `direct`, `hls` or `unsupported`
and starts **nothing**. An MP4 of H.264 and AAC is `direct` — served by the
existing `GET /api/library/file`, which already answers range requests, at zero
CPU and zero disk. Only what a browser refuses is remuxed. The verdict is cached
per **(size, mtime)**, not per path: a re-download over the same filename is a
different file, and a cache keyed on the name would go on describing the old one.

⚠️ `unsupported` is a real answer, not a gap. VP9 and AV1 have **no MPEG-TS
mapping**, so `-c:v copy` is impossible and the only alternative is re-encoding
the video — an hour of CPU on a box that also runs Home Assistant and Frigate,
to produce a worse picture than the file already holds. Those get the download
button and a sentence saying why.

### 🔴 Three faults found by running it, not by reading it

All three were invisible to the tests as written, and all three were found by
pointing a real browser at the real 67 MB MKV.

**1. Playback started at 3:28 of 4:22.** A playlist that ffmpeg is still writing
has no `#EXT-X-ENDLIST`, which Chrome reads as *live* — and a live stream starts
at the live edge. Nothing errored; it played the wrong part of the video. Fixed
by injecting `#EXT-X-START:TIME-OFFSET=0,PRECISE=YES` into the playlist we serve.

**2. A segment was served while ffmpeg was still writing it.** "The file exists"
is not "the segment is finished": ffmpeg creates `00002.ts` and fills it over the
next fraction of a second, and a player handed those first bytes gets a truncated
MPEG-TS and fails the whole stream — `DEMUXER_ERROR_COULD_NOT_PARSE` at 0:15.
The fix is to treat **the playlist as the authority**: ffmpeg appends a segment's
`#EXTINF` line only after closing the file, so a name that appears in
`index.m3u8` is complete, always. That one rule also gives the "wait a moment if
it is being written" behaviour for free.

**3. Chrome says it plays HLS, and does not.** See `docs/DISCOVERIES.md`.

### The limits, because this writes real bytes to real disk

The Dua Lipa MKV — 66.7 MB, 4:22, 1080p — leaves **71.1 MB** of `.ts` in 43
segments. A film leaves several hundred. So:

- **One session per file.** `ensure()` is synchronous up to `sessions.set`, and
  that *is* the mutual exclusion: three simultaneous requests start one ffmpeg.
  An `await` above that line would reopen the window and put two ffmpegs in the
  same directory, corrupting the playlist as well as doubling the CPU.
- **Three sessions at once** (`HLS_MAX_SESSIONS`). Over the cap, a *finished*
  session is evicted to make room; if they are all mid-remux the answer is
  `TranscodeBusy` (503, retryable), never a fourth ffmpeg.
- **Two idle deadlines**, because they cost different things. A finished session
  is disk: an hour (`HLS_IDLE_MS`). A session still remuxing that nobody is
  reading from is **CPU**: five minutes (`HLS_TRANSCODE_IDLE_MS`), because that
  is a closed tab, and an orphaned remux is the failure nobody would notice.
- **A wipe on startup.** A crash leaves segments that no in-memory session knows
  about and nothing would ever collect. Verified: 72 MB left behind by a hard
  kill was gone on the next boot.
- `GET /api/library/hls/sessions` reports the bytes, so the disk is visible
  before it is full.

### Measured, against the real file

| | |
|---|---|
| Playlist with a playable first segment | **0.54 s** from a cold request |
| Whole 4:22 remux | **12.3 s** — video copied, only Opus→AAC encoded |
| Disk left | **71.1 MB**, 43 segments, 3.0–9.6 s each |
| Seek to 3:00 | **212 ms**, then played on normally |
| Seek back to 0:30 | **215 ms** |

⚠️ Segments are 3.0–9.6 s, not 6.0. That is `-c:v copy` doing its job: cuts land
**on keyframes**, because a segment that does not start on one decodes to grey
mush. Forcing exactly six seconds would mean re-encoding.

### `src/web`, touched as little as possible

Another agent owns that folder this session. Three things only, all in the two
places that name the route: `libraryHlsUrl()` and `canPlayHlsNatively()` in
`data/library.ts`, and `playableUrl()` in `screens/Library.tsx` now returning the
HLS URL instead of `null`. The download button was already there — not duplicated.

---

## 2026-08-27 — Seven things found by using it

Santi used the built app and came back with seven. Three were red: the player,
the double close button, and the two inspector tabs that did nothing.

**455 tests, 0 failures** (was 445; +10 new). `tsc` clean.
React Doctor **58 / 100** against **57 / 100** on `HEAD` — nothing here made it
worse, and none of the reported issues is in a file this work touched.

### 🔴 The player was waiting for an endpoint that already existed

`playableUrl()` returned `null` and the panel said *"Playback needs a
media-streaming endpoint, which this build's API does not have"*. `GET
/api/library/file` has ranges, 206s and `Content-Range`, and has had them for a
while: the sentence was **stale documentation rendered as a feature flag**.

Now `src` is `libraryFileUrl(item.path)` and the MP4 plays — verified in a
browser, playing and seeking (`currentTime` 3.9 → 16.9 across a seek, `video.error`
null).

⚠️ **But `null` still happens, and it is now about the container.** No browser
plays Matroska, whatever is inside it, so an MKV gets the poster, no play
triangle, and *"MKV is not playable in browsers — download it instead."*
`isBrowserPlayable` (in `data/library.ts`) is deliberately conservative — `.mov`
is not on the list, because a download offered where one browser could have
played is a far smaller failure than a play button that does nothing.

### The download button, and why it is an anchor

`?download=1` on the same route swaps `Content-Disposition: inline` for
`attachment`, with **both** filename forms — the quoted ASCII one and RFC 5987's
`filename*` — because library names carry accents and quotation marks. It rides
on the 206 too: a resumed download that loses its name lands as `file.bin`.

In the panel it is an `<a download>`, not a button with a handler: the browser's
own save, which shows in the download manager and needs no JavaScript. Verified
by downloading through the browser — byte-identical to the file on disk.

### 🔴 Tasks and Logs did nothing on the Downloads screen

```tsx
<JobInspector job={selected} tab="details" onTab={() => undefined} … />
```

The tabs are controlled, so this rendered three tabs that behaved as one: the
click changed a value the component overwrote with the same constant. The Queue
had had it right all along — `panel` in the URL — and Downloads had a copy with
the wiring cut. `DownloadsSearch.panel` now exists and the URL carries
`?panel=logs`.

Worth naming because of *which* screen it was: this is where you go to find out
why a download failed, and the log was on the tab that could not be opened.

### 🔴 Two close buttons on every side panel

`SheetContent` renders its own close and every panel inside already had one, so
the responsive view had two X's a finger apart — which is how it reads on an
iPad. `showCloseButton={false}` on the three sheets that wrap a panel (Queue,
Downloads, Library). The navigation sheet keeps its own: nothing inside it
closes anything.

### The rest

- **Thumbnails are 128 px wide**, twice what they were. At 64 a video is a
  coloured smudge, and recognising the row is the whole job of that column.
- **The plugins screen says how to start.** "No plugins installed" was the whole
  message. Now: the annotated template as a **downloadable file**
  (`GET /api/plugins/template`), the documentation **served** (`/api/plugins/docs`),
  and the **exact directory**, which comes from the server because it depends on
  `DATA_DIR`. See `docs/DISCOVERIES.md` for why those are string constants in
  `src/` rather than the repository's own `plugins/README.md`.
- **A house in the sidebar**, in place of the download arrow. The name is
  *Casa*Tube, and the arrow was one screen's icon wearing the badge of all of
  them.

### The test that is worth keeping

`plugins.test.ts` downloads the template through the route, writes it into a
plugins directory, reloads the runtime and asserts it comes up. A template that
reads well and does not load is worse than none — it fails on someone else's
machine, after a restart, in a file they were told to trust. That test is also
what caught the plugin-default described in `docs/DISCOVERIES.md`.

---

## 2026-08-27 — The codec stopped being a decision taken for you

> «hoy el códec de vídeo se muestra pero no se puede elegir.»

`VIDEO_CODEC_PREFERENCE` was right about the trade-off and wrong to settle it:
AV1 forces a transcode on a media server without a GPU, H.264 direct-plays — and
which side of that matters depends on where the file gets watched, which the
code cannot know. So the order stays, as one option among six.

**445 tests, 0 failures** (was 421; +22 new). `tsc` clean.

### The shape

`Preferences.videoCodec: "auto" | "efficient" | "h264" | "vp9" | "hevc" | "av1"`,
default `auto` — bit-for-bit the old behaviour, which is why
`selection.test.ts`'s original 61 tests never moved.

- `auto` — H.264 first. The historical order, now named.
- `efficient` — AV1/VP9 first: fewer bytes, at the risk of a transcode.
- a named codec — **the codec is kept and the resolution gives way**, never the
  reverse. Naming H.264 means "this has to play without transcoding", and
  answering with 4K AV1 answers a question nobody asked.

### 🔴 The part that is not a feature: saying so

On YouTube, AVC1 stops at 1080p. "H.264 at 4K" is a request that cannot be
filled, and the old code filled it with a different codec **without a word**.

`selection.videoCodecNotice()` is pure, tested, and the single author of that
sentence. It distinguishes the two honest failures — `resolution-capped` (the
codec exists, not that high) and `codec-unavailable` (the media has none of it,
so something is standing in) — and everything else quotes it:

| Layer | How it says it |
|---|---|
| `POST /api/probe` | `warnings[]`, computed for the preferences the call carried |
| `options.codecs[]` | a `caveat` per choice, measured against this video |
| `options.resolutions[].byCodec` | per height × choice: what would really be downloaded, and `exact: false` when that is not what was asked |
| The form | a badge per codec ("up to 1080p", "not in this video"), a marker on the affected resolution rows, one warning line, and a preview showing the file that *arrives* |
| `analyze` stage | the same sentence into the job log — an API call or a watched source never passed through a form |

Verified live against `dQw4w9WgXcQ` (4K remaster, 37 formats): asking for
2160p + H.264 returns *“There is no H.264 above 1080p in this video — at 2160p
it is VP9 and AV1 only. The download will be 1080p H.264.”* and the plan is
format 137. Asking for HEVC, which the video does not have, names VP9 as the
stand-in.

### The resolution list is grouped by codec now

1080p is not one thing: on that video it is 119 MB of H.264, 45 MB of VP9 or
29 MB of AV1, and which one arrives decides whether the media server plays the
file or transcodes it. One row per height hid both facts.

⚠️ And the row for a height the chosen codec cannot reach **stays on the list**,
flagged. Hiding 2160p because H.264 stops below it would be the same silence in
a new place: the resolution exists, it is the combination that does not.

### React Doctor

**57 / 100, 52 issues — byte-identical to the same scan on `HEAD`.** Nothing
here made it worse. ⚠️ The 70 / 100 recorded below is stale: the drop happened
in `c335f13` (the dashboard, ~25 components), not in this work.

---

## 2026-08-26 — The form stopped asking blind

> «las resoluciones y etc deben aparecer después de que se ponga el video, así
> se sabe qué hay disponible; lo mismo para el audio e igual para los
> subtítulos… Destination folder igual, no me dice qué folders hay.»

One fault, four times over: **the form asked for decisions without showing the
choices.** A fixed list offered 4K for a 720p video; "original audio only" named
a track nobody could see; automatic captions looked exactly like authored
subtitles; the destination was a text box that never said what existed.

**203 tests, 0 failures.** `tsc` clean apart from three pre-existing errors in
`src/providers/ytdlp.test.ts` — `buildFetchArgs(plan(), {})` is missing its
`workDir` argument in three places (added in 3cfd2d4, test-only, not touched
here).

### What was built

| Where | What |
|---|---|
| `src/api/destinations.ts` | `GET`/`POST /api/destinations` — the folders that exist, and creating one |
| `src/api/options.ts` | A probe turned into **choices**: real resolutions, audio grouped by language with the original marked, subtitles with authored told apart from automatic |
| `src/api/probe.ts` | Now answers `{ info, options, suggested }` |
| `src/web/components/MediaPicker.tsx` | The three lists, as checkbox rows |
| `src/web/components/DestinationPicker.tsx` | The folder list, with a typed name as the fallback |

### The two decisions worth keeping

**The options and the preselection are derived on the server, by calling
`core/selection` itself.** Not an imitation of the selection logic that can
drift from it — the same functions `analyze` runs, on the same input. "Ticked by
default" is therefore *provably* what the worker will do, and R3 holds: the
browser renders what it is told.

**One row per language tag, not one per track.** `Preferences` names languages,
not track ids, so a row per track would let the user pick something the request
cannot express — two English streams, or the automatic captions for a language
that also has authored ones, which `selectSubtitles` overrides anyway. Verified
against MrBeast's Squid Game video: 120 audio streams fold into 23 language
rows, English marked original, `por` and `pan` among them — HomeTube's two
famous wrong tags, here attached to the right languages.

⚠️ **A dead library mount hangs rather than failing**, so every filesystem call
in `destinations.ts` runs under a deadline and reports `MountUnavailable`
(503). An abandoned `readdir` cannot be cancelled — it runs on the threadpool,
so it does not block the event loop, and racing it is the honest version of
"give up". The picker falls back to a text box, which still queues correctly
because the move stage creates whatever folder it is given.

📌 **A failed probe never blocks the queue.** It renders as a warning and the
Download button stays live: `analyze` reads the media again anyway. Not being
able to look must not stop you downloading.

### React Doctor, run as the worklog asked

**70 / 100, 29 issues** — the same score as before this work (70 / 100, 28
issues). The performance count is back where it started; the one added issue is
`deslop/unused-file` for the two new components, which the scanner reports for
*every* component in `src/web` because it does not follow the JSX import graph
from `index.html`.

```bash
bunx react-doctor@latest                      # full scan
bunx react-doctor@latest --verbose --scope changed
```

📌 Still worth re-running **before** the shadcn/Tailwind reskin: fixing a
structural problem is cheaper while the components are still plain.

---

## 2026-08-26 — Worker done, R2 proven

**166 tests, 0 failures.** The acceptance test for the whole project passes:

> Start a job, interrupt it **mid-download**, close both database files, shut
> the embedded queue manager down, boot again against the same paths — the job
> recovers with its bytes intact, is claimable again, and completes.

Nothing in that test uses `:memory:`. R1 needs no test: the browser is not
involved in the worker at all, which makes it true by construction.

### Two design faults that only surfaced by running it

Both were mine, and neither would have been caught by reading the code.

**`jobs.provider` was `NOT NULL`, but nobody knows the provider at enqueue
time** — it is resolved in `validate`. Requiring it earlier would mean resolving
a provider *before the job is durable*, which is work done outside the thing
that survives a restart. Now nullable, recorded by `validate`.

**The plan lived only in a variable.** On resume, `analyze` is already `done` so
it is skipped — and the plan went with the dead process. The job then
"downloaded" nothing and reported success. Now `jobs.plan` is a column: it is a
*decision about the job*, not a working value, and re-probing on every resume
would spend IP budget recomputing something that has not changed.

📌 The second one is the more interesting failure: the pipeline was correct, the
persistence was correct, and the seam between them lost the work silently. That
is exactly the shape of the bug this project exists to eliminate.

---

## 2026-08-26 — Phase 1 core landed

**164 tests, 0 failures** (5 skipped: they need the network). `tsc` clean.

Built: `selection.ts`, `db.ts`, `queue.ts`, `providers/ytdlp.ts`,
`providers/registry.ts`. Still missing for phase 1: **the worker** — the
six-stage pipeline that joins them.

### 🔴 The root cause of HomeTube's language bug, finally

We knew HomeTube tags audio `por` and `pan` when it is English and Spanish. We
did not know why. Now we do:

> `FFmpegMergerPP` (`postprocessor/ffmpeg.py:822`) merges with `-c copy` and
> `-map` and **writes no language metadata at all**. The tag on the output is
> whatever the DASH fragment happened to carry.

So it is not a mislabelling bug — **nobody was labelling anything**. The fix is
to pass the tags explicitly from `plan.languageTags`:
`--postprocessor-args "Merger+ffmpeg_o:-metadata:s:a:0 language=eng …"`, where
stream index N corresponds to `plan.audio[N]` because the merger maps in
selector order.

### More traps found, all verified against the real binary

- **The two-pipe trap is caused by `--quiet`.** Without `-q`, both download and
  post-process progress go to stdout; with `-q`, post-process moves to stderr
  (`YoutubeDL.py:664`). We use `-q --progress` and read both pipes.
- **With formats to merge and no ffmpeg, yt-dlp exits 0**, warns, and
  `--print after_move:%(filepath)s` names a file it never wrote. So `fetch`
  checks the file exists before returning Ok, and does not pass `--no-warnings`.
- **`--write-subs` downloads subtitles first.** A 440-byte `.vtt` finishes
  instantly and is reported through the same progress template, so the bar hit
  **100% before the video began**. Sidecars are excluded from the byte budget,
  and progress accumulates by filename rather than `format_id`.
- **`--audio-multistreams` is off by default**: without it a `v+a1+a2` selector
  silently keeps one audio track.
- Confirmed: `--color no` exits 2 and the message never says "option".

### Contracts extended after the agents reported gaps

`FetchFailed` and `ProviderCancelled` (reporting a cancellation as a failure was
a lie); `AudioTrack.approxBytes` so the progress total does not grow mid-job;
`ProgressUpdate.stage` so 100% during merging is distinguishable from done;
`Preferences.embedSubtitles` — the designs expose it as a toggle, so it belongs
to the user, not to the plan.

⚠️ **`isOriginal` inference, worth knowing**: when no format carries the
`original` marker and there is exactly **one** audio language, the provider marks
that track original — otherwise `originalOnly` would have no candidate on the
common case of a video with no dubs. With two or more languages and no marker,
**none** is marked. Never all.

---

## 2026-08-26 — Foundation laid

### State

Planning is **finished**. [`PLAN.md`](PLAN.md) — 1,070 lines, 20 sections, no
open decisions. Every non-obvious choice records the reasoning that lost, not
just the conclusion.

**Committed and typechecking clean:**

| File | What it is |
|---|---|
| `src/core/schema.ts` | Drizzle schema — **the single source of truth for types** |
| `src/core/types.ts` | Shared contract + the provider-neutral media vocabulary |
| `src/core/errors.ts` | Tagged error taxonomy (`better-result`) |
| `src/core/plugins.ts` | Plugin, hook and capability contracts |
| `drizzle/0000_*.sql` | First migration, generated |

Dependencies installed: `elysia`, `@elysiajs/eden`, `drizzle-orm`,
`better-result`, `bunqueue`; dev: `typescript`, `@types/bun`, `drizzle-kit`.

### Why the foundation was written by hand, first

The first attempt at this project was thrown away. **The code was not the
problem** — work went to parallel agents before the requirements were settled,
and the brief then changed three times mid-flight (language, scope, framework).

So: contracts are written and committed **before** any work is handed out. They
are what parallel work depends on, and they are the thing that must not move.

### Next: phase 1 — core

Done when **a job survives `docker restart` mid-download and completes**. Not
"the tests pass".

Work that can go in parallel, each against the committed contracts:

1. **Queue** — bunqueue behind the narrow seam (`enqueue`, `claimNext`,
   `update`, `recoverOnStart`), leases, priority ordering, recovery on startup.
2. **Selection** — pure logic: formats, audio, subtitles, **correct language
   tags**, safe filenames. This is where HomeTube's three bugs live.
3. **yt-dlp provider** — `supports`/`probe`/`fetch`/`list`, structured progress
   via `--progress-template`.
4. **Worker** — the six-stage pipeline, temp-then-move, retries, cancellation.

### Traps already paid for — do not rediscover these

- `postprocess:` progress goes to **stderr**, not stdout. A stdout-only reader
  sees post-processing as a hang.
- **`--color no` does not exist.** It is `--color never`; `no` exits with code 2
  and the message does not say the option is invalid.
- A 1080p download is **several files in sequence** (video + one per audio
  track). Per-file progress makes the bar reset to 0% on each one.
- Test restart recovery against a **real database file**. With `:memory:` the
  test proves nothing.
- ⚠️ **Instruments lie.** During the first attempt: `grep -c` counted
  commented-out lines as enabled config; a registry paginated its tags so a
  published version looked missing; a status endpoint excluded exactly the item
  type being checked. Before concluding something is absent, confirm the check
  could have seen it.
