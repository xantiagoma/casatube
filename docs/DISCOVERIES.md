# Discoveries

Things that cost time to find, written down so they cost it once.

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
