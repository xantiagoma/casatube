# Worklog

Where the work is, so it can be picked up by anyone — including a future
session with none of this context. Newest first.

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
