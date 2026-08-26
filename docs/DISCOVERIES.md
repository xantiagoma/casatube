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
