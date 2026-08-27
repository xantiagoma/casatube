# Discoveries

Things that cost time to find, written down so they cost it once.

## Chrome says it plays HLS, and then does not (2026-08-27)

Chrome 152 answers `"maybe"` to
`video.canPlayType("application/vnd.apple.mpegurl")` and really does play a
**finished** playlist: the 67 MB MKV remuxed to 43 segments played from 0:00,
seeked to 3:00 and back, with no error.

Point it at a playlist that is **still being written** and it dies a few seconds
in with `PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE`. An unfinished playlist
has no `#EXT-X-ENDLIST`, Chrome reads that as live, and its live MPEG-TS
pipeline never recovers — even after ffmpeg finishes and `ENDLIST` appears.

⚠️ **Every first play is a playlist still being written.** So the capability
check is a lie in exactly the case that matters, and `canPlayHlsNatively()`
excludes Chromium by name rather than believing it.

The same bytes, over the same routes, played and seeked perfectly under
**hls.js 1.7.1** — which is what settles that this is Chrome's player and not
our segments. `ffmpeg -i <the playlist URL> -f null -` also decodes the whole
stream with no warnings, and all 43 segments are byte-identical to what is on
disk.

📌 The general shape, and it is the third time this month: a runtime that
answers a capability question about a *format* when the real variable is the
*state of the resource*. `canPlayType` cannot see that the playlist is still
growing, so it answers a question nobody asked.

## An HLS player treats a file that exists as a segment that is finished (2026-08-27)

ffmpeg creates `00002.ts` and then fills it. A reader that serves it as soon as
it exists and is non-empty hands the player a **truncated MPEG-TS**, and the
player does not retry — it fails the whole stream. With a cacheable response the
browser then keeps the broken copy, so the symptom outlives the cause.

There is no way to observe "this file has stopped growing". The playlist is the
authority instead: ffmpeg appends a segment's `#EXTINF` line **after** closing
the file, so a name listed in `index.m3u8` names a complete segment, always.

📌 Worth knowing because the same instinct — "wait for the file to appear" — is
what a brief asks for, and it is the wrong test. Waiting for the *index* to
mention it is both correct and simpler.

## `-c:v copy` means the segment length is a suggestion (2026-08-27)

`-hls_time 6` on the real MKV produced segments of **3.0 to 9.6 seconds**. That
is not a bug and it is not worth fixing: with the video copied, cuts can only
land on keyframes, and a segment that does not start on one decodes to grey
mush until the next IDR frame. Forcing six seconds means re-encoding, which is
the thing on-demand HLS exists to avoid.

⚠️ Related: MPEG-TS cannot carry VP9 or AV1 at all. A VP9 MKV is therefore not
"slow to play", it is **impossible** to play without re-encoding the video — so
`core/hls.ts` reports `TranscodeUnavailable` rather than starting an hour of CPU.

## A relative segment URL loses the query string that identified the file (2026-08-27)

ffmpeg writes bare filenames into the playlist (`00000.ts`), and a player
resolves those against the playlist's URL. Ours is
`/api/library/hls/index.m3u8?path=…` — and **the query string takes no part in
relative URL resolution**, so the player asks for `/api/library/hls/00000.ts`
with no idea which file it belongs to.

The playlist is rewritten on the way out, one `?path=` per segment line. ffmpeg's
own output on disk stays untouched and correct.

## `app.stop()` waits for keep-alive sockets, so a proxy makes shutdown look hung (2026-08-27)

SIGTERM took **30 seconds and never completed** while a Bun `fetch`-based proxy
was pointed at the server, and **0.5 seconds** with the same HLS session running
and no proxy attached. Bun's `fetch` holds the connection open; `app.stop()`
waits for it.

📌 It looked exactly like a shutdown bug in the code being written that day.
Before blaming a new `await` in the shutdown path, check who still has a socket
open — and note that curl does not reproduce it, because curl closes.

## Eden revives ISO strings into `Date` by default (2026-08-26)

`treaty()` runs a reviver over every response that turns any ISO-8601 string
into a `Date` — `createdAt`, `updatedAt`, and every timestamp in an SSE frame.

**The server sends strings and the types say `string`.** So the default makes
the runtime disagree with the compiler on every timestamp in the application.

The symptom was not an error. The queue rendered once and then froze with the
connection indicator still reading "Live": frames were arriving and being
silently discarded by a `typeof at === "string"` guard. Nothing logged, nothing
threw.

```ts
treaty<App>(origin, { parseDate: false })
```

📌 The general shape: a client that is "helpful" at runtime in a way the types
do not describe. Type-safety end to end does not help when one end quietly
transforms the values after the types have been checked.

## A plugin CasaTube has never seen before starts **enabled** (2026-08-27)

`createPluginRuntime` takes `defaultEnabled`, and it defaults to `true`. So a
file dropped into `DATA_DIR/plugins/` is **active at the next restart** — its
`setup` runs, its hooks dispatch — and the switch in Settings is what turns it
*off*. Only a name already in `plugin-state.json` is remembered.

It matters because the natural thing to write on an onboarding screen is the
opposite ("it appears switched off, nothing runs until you turn it on"), which
is reassuring, plausible, and false. It was written into the template *and* the
screen before a test caught it: `expect(state).toBe("disabled")` came back
`"active"`.

📌 The general shape: a default that is safe to assume is not the same as a
default that is true. Assert the ones you are about to describe to a user.

## The repository is not in the image, so nothing served can be read from it (2026-08-27)

The Dockerfile copies `package.json`, `tsconfig.json`, `drizzle` and `src`. Not
`plugins/`, not `docs/`, not any `*.md`. A route that answers with the contents
of `plugins/README.md` therefore works perfectly in development and 404s in the
only deployment anyone runs.

So the plugin template and the condensed documentation are **string constants in
`src/api/plugin-template.ts`**, not files read off disk. The full reference stays
in `plugins/README.md` and the served copy says so at the bottom — two copies is
the price of the answer being available where it is asked for.

📌 Anything the *server* must hand over lives under `src/`. The repository is a
development convenience, not a runtime resource.

## `sm:max-w-lg` inside shadcn's `DialogContent` beats a bare `max-w-3xl` (2026-08-27)

`cn(..., "sm:max-w-lg", className)` puts the caller's class last in the *string*,
which changes nothing: Tailwind emits variant utilities after unprefixed ones, so
above the `sm` breakpoint — i.e. always, on anything but a phone — `sm:max-w-lg`
wins and a dialog asked to be `max-w-3xl` renders at 32rem. Nothing errors; the
dialog is simply narrow.

Pass `sm:max-w-3xl`. Same trap as `CardHeader` being a grid: a class that is
inert rather than wrong.

## The probe happens once, so anything preference-dependent must ship for *every* choice (2026-08-27)

`useProbe` is keyed by the **URL alone** — deliberately, because one probe per
URL is the IP budget (PLAN §4.3). Preferences travel in the request body and
only shape the answer.

The consequence is easy to miss and it bit while adding the codec selector: any
field in `MediaOptions` computed *from* the preferences is **frozen at the
moment of the probe**. Moving a radio in the form does not recompute it, and the
first version of the codec picker quietly rendered stale flags — the 2160p row
kept claiming H.264 was available after H.264 was chosen, because that flag had
been computed under `auto` fifteen seconds earlier.

The two fixes that do not work: re-keying the query on the preferences (a probe
per checkbox) and re-deriving in the browser (the selection rule copied into the
one place it can drift from `core/selection`).

What works is to answer **all** the choices up front:
`resolutions[].byCodec` holds `selectVideoFormat(formats, height, codec)` for
every height × every codec choice, so the browser does a lookup and the server
still owns every decision.

📌 The general shape: caching keyed on less than the answer depends on is not a
stale-data bug, it is a **silently wrong UI**. Either key on everything, or send
everything.

## YouTube reports a bitrate for every format and a size for almost none (2026-08-26)

`yt-dlp -J` on a YouTube video fills `tbr`/`vbr` on every DASH format and leaves
`filesize` and `filesize_approx` null on nearly all of them. A size column fed
only by the reported number is therefore **empty exactly where it is wanted** —
on the resolution list someone is choosing from.

So `api/options.ts` estimates it as `bitrate × duration / 8` and marks the row
`bytesEstimated`. Both numbers are approximations; the flag says which kind.
Verified live: `dQw4w9WgXcQ` gives 2160p ≈ 485 MB, 720p ≈ 32 MB, with no
`filesize` on any of them.

⚠️ Related, and it costs an afternoon if unknown: **`toLanguageTag` folds
`zh-Hans` and `zh-Hant` into one `chi` row.** That is correct — a container tag
has no room for the script — but it means two audio streams that a person would
call different languages become one option. Simplified vs Traditional cannot be
expressed by `Preferences`, which names languages.

## The local yt-dlp may be too old to extract YouTube at all (2026-08-26)

`yt-dlp 2024.07.09` fails every YouTube extraction; the live tests notice and
skip. Any end-to-end check against a real URL needs a current binary:

```bash
curl -sSL -o /tmp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x /tmp/yt-dlp && YTDLP_BIN=/tmp/yt-dlp bun src/server.ts
```

📌 The failure is loud in the test output and silent in the app: a probe just
returns `ProbeFailed`. Check the version before blaming the code.

## Elysia's `t.UnionEnum` applies a default you did not ask for

`t.UnionEnum([...])` sets `default: values[0]`, and query coercion applies it.
So an **optional** `?level=` arrives as `"info"` and silently filters the list.

Nothing errors. It was caught only because a seeded `error` notification
vanished from the HTTP response while the store still returned it — the two
disagreed, and the store was right.

```ts
t.Optional(t.UnionEnum(["info", "success", "warning", "error"], { default: undefined }))
```

Verified against Elysia 1.4.29.

📌 Same shape as the Eden date trap above: a framework being helpful at runtime
in a way the types do not describe. Both were found by noticing that two layers
disagreed, not by a failing test.

## Elysia's `fail()` needs a literal union of status codes

With a plain `number`, Elysia collapses the response type and **the success
shape disappears** — the client's `data` becomes the error type and the real
payload is gone. Declare the codes as a literal union.

## yt-dlp

See `PLAN.md` §4.2 for the ones that shaped the provider. In short: `--quiet` is
what moves post-process progress to stderr; `--color no` does not exist
(`--color never`); yt-dlp exits 0 when it cannot merge and then names a file it
never wrote; and `--write-subs` downloads a tiny subtitle first, which drives a
naive progress bar to 100% before the video starts.

## Three that cost time building the UI (2026-08-26)

**TypeScript 7 removed `baseUrl`.** Path aliases are now resolved relative to
the `tsconfig.json` itself. An alias that worked yesterday silently stops
resolving, and the error points at the import rather than the config.

**shadcn's `CardHeader` is a grid, not a flex row.** So `flex-row
justify-between` on it is inert — nothing errors, the layout simply ignores you.
Use `CardAction` for the right-hand slot.

**Dice UI's media-player root carries `size-full`**, which stretches it into a
tall black band unless you pass `h-auto`.

⚠️ Also fixed while there: an upstream listener leak in Dice UI's
`media-player.tsx`. `timeupdate`, `volumechange`, `error` and `fullscreenchange`
were added with inline arrow functions and "removed" with freshly created ones —
so four listeners leaked per mount. Worth knowing that vendored components are
now our code: nobody upstream will fix that for us.
