# Worklog

Where the work is, so it can be picked up by anyone — including a future
session with none of this context. Newest first.

---

## 2026-09-19 — Telegram, and a ceiling that refused every portrait video

> «is casatube capable of downloading videos from a private telegram channel?»

No, and it took a provider of its own to make it one. Along the way it surfaced a
bug that had nothing to do with Telegram and had been refusing phone video since
the resolution ceiling existed.

**1174 tests (1120 → 1174), 0 failures. `tsc` clean.** Six commits, deployed and
pushed.

### Why a provider and not a plugin

yt-dlp has one Telegram extractor and it reads the *public* web preview. A
private channel has no such page and the video is never an HTTP URL — it arrives
as encrypted chunks requested with `upload.getFile`. Cookies cannot help, because
there is nothing to point at.

A plugin could not have done it either, and both reasons are about what a plugin
can reach: a plugin file is imported by this process, so it can only import what
the *app* installed — `teleproto` has to be a dependency either way — and the
session lives in the credential store, which the plugin API does not expose.

⚠️ `gramjs` is archived. The npm registry says so itself, pointing at `teleproto`
as the maintained fork — confirmed against the registry rather than taken on
faith, and then confirmed to load and construct under **Bun**, which is what made
an in-process provider possible instead of a Python subprocess.

### The credential store accepted four types and could deliver two

`acquire()` resolved against `["cookies", "password"]` and returned `null` for
`apiKey` and `custom`, so a credential the store validated, sealed, stored and
**listed as present** could never be used by anything.

🔴 That was a deliberate guard, not an oversight — a test asserted *"an API key is
never handed to yt-dlp"*, because a key has nowhere to go on a command line and
picking one would shadow a cookie jar that would have worked. So the guard moved
rather than went: it is the **default argument** now, and a caller that knows what
to do with another type names it. The promise is kept where it can be proved —
`withCredentials` copies three fields and cannot pass on what it never reads.

### Three attempts at a login, and the user was right twice

The first version was a script that stored the credential itself. Santi: *"no
entiendo por que esas cosas no son algo que pongo en el plugin config y ya"* —
and the answer was that the Credentials screen already stored exactly this, with
`custom` key/value fields, sealed. Storing needed **no code at all**. The script
lost everything except the one thing a form cannot do: produce a session string,
which needs a code submitted inside the same MTProto connection.

Then the hidden prompt hung. A hidden prompt needs raw mode, raw mode needs its
own reader, and `readline` already held stdin — the bytes went to readline and
Enter did nothing. `_writeToOutput` is `undefined` in Bun; a swappable output
stream swallowed two answers at once. 📌 **A prompt that works beats a prompt
that hides.** Nothing is hidden now, and the error messages still never echo a
value, because an error line is what gets pasted into a chat.

Finally the UI he asked for: three steps in Settings → Credentials.
`core/telegram-login.ts` is the only thing in this process that holds state
between requests, and it has to. It expires, it caps at three, it evicts the
oldest rather than refusing the newest, and a wrong code deliberately does *not*
drop the login — Telegram allows retrying the same code request, and closing the
connection would make a typo cost a new SMS.

⚠️ The session string never reaches the browser. **Eden's derived types caught
that the `start` route could in principle serialise one**, so all three steps
share a single exit and the session has exactly one path out of the manager: into
the store.

### 🔴 And then: resolution was the height

Two downloads failed with `FormatUnavailable` against the default 1080 ceiling.
My first explanation was that the videos were above it. They were **720×1280** —
portrait. A 720p phone video judged by its height is "1280p", and the form had
already been labelling it that: a number that refutes itself the moment anybody
reads it beside `720x1280`.

📌 Never a Telegram problem. A portrait YouTube Short at 1080×1920 had been
refused by the default ceiling for as long as the ceiling existed. Telegram only
made it common enough to notice.

It survived because **in landscape the height *is* the shorter side**. All 94
selection tests passed unchanged after the fix — which is the evidence that it is
a no-op for landscape, and exactly why none of them caught it.

`ResolutionOption.height` became `resolution`. Keeping the name with the shorter
side inside it would have been a field that lies, which is the version of this bug
that comes back.

### And Google Drive, for a reason that took three wrong guesses

> «que me recomiendas? es esto un impedimento para descargar o solo obtener la
> metadata?»

A Drive link failed with *"the source is rate-limiting us."* The classifier was
right — a literal `HTTP Error 429` — and the attribution was wrong three times
over: the ceiling, the file's download quota, our IP. Each fit the symptom.

Asking the three suspects separately settled it: the file's page answered 200, so
did the download endpoint, and `googleapis.com/drive/v3` answered **403** for the
API key **compiled into yt-dlp and shared by all of its users**. yt-dlp was
honest about being rate-limited; the thing being limited was a key shared with the
world.

📌 And it answered his question: **not a metadata inconvenience.** The extractor
aborts at extraction — a full run left an empty directory — so "queue it anyway,
the worker analyses again" was not a path around it.

`providers/drive.ts` takes the path that worked all along and never touches a key.
The download is verified against the stated total, because a reset connection ends
a stream and everything looks finished. The fixture HTML is real, captured while
diagnosing this, on the grounds that a hand-written page would test the parser
against my idea of Drive rather than against Drive.

⚠️ Scraping, and accepted as such: the alternative was scraping *plus* a dead
shared key.

### Vidarro, and a hook that was only wired into half the app

> «tenemos algo para bajar de vidarro?»

No — and the useful part was working out what "something" needed to be. yt-dlp has
no extractor for it; its generic fallback finds a **Voomly** embed and gives up.
But the share page carries the HLS manifest, and handed that directly yt-dlp
listed the whole ladder, 240p to 720p. So the gap was extraction, not download,
and a twenty-line `url:resolve` plugin beat a provider that would have
re-implemented HLS, the ladder and the merge.

🔴 The decision with an edge: the page offers the master manifest *and* one per
quality. Returning `file720p.m3u8` works and hard-codes the resolution, leaving
the ceiling in Preferences with nothing to decide — someone asking for 480p would
silently get 720p. That is the part with tests, because nothing about it looks
like a failure.

⚠️ And then deploying it found what reasoning had not: `/api/probe` still answered
`UnsupportedUrl` while the queue downloaded the same link fine, because
`url:resolve` was dispatched from the enqueue path only. A form that contradicts
the queue is worse than a form that fails — see `DISCOVERIES.md`. Both paths run
the hook now, with a test whose fake provider claims only what the rewrite
produces.

📌 Worth noting what these three sources have in common and how they differ:
Telegram and Drive are **one file** each, so a resolution ceiling has nothing to
act on; Vidarro is a real ladder, so the preference means something. Which is also
why the portrait fix mattered here — those formats are 720×1280.

### Verified against the real thing

A private channel, his account: probe returned the caption as the title, 491 s,
1282×720; the download landed 212 MB in ~20 s under a name from the caption and an
extension from the real MIME type; and the sign-in dialog replaced the
script-made credential with `Telegram — @xantiagoma`, after which `last_used_at`
moved from `never` to a timestamp — which is the store recording that the *new*
session was the one that worked.

Drive, against the file that started it: the probe titled it from
`content-disposition` with no key involved, and the download landed **586131454
bytes in 14.9 s** — matching the stated total exactly, which is the truncation
guard passing its good case rather than only its bad one.

---

## 2026-08-28 — The handoff's open list, closed — and a plugin system that never ran

> «ok sigamos con el tier a & b»

Six items off the handoff's *Still open* list. Two of them turned out to be
much larger than they read, and both for the same reason: the reported symptom
was the visible edge of something that had never worked at all.

**1060 tests (1003 → 1060), 0 failures. `tsc` clean.** Five commits.

### 🔴 Plugins were never dispatched. Not once, at any hook point

The task was PLAN §5's per-download override. Following the dispatch path to
find where the override would apply led nowhere: **nothing in the pipeline
called `runtime.run`**. Plugins were discovered, validated, activated, listed
on Settings with their capabilities and hooks, enabled, disabled, configured,
and the download window said which ones "apply" — and the worker was never
handed the runtime at all.

Proven rather than argued, because a search proves only that a search found
nothing: a plugin declaring all six points and logging at each was installed on
a running server, a job was queued, and it printed nothing.

📌 The reason it survived is worth keeping. **Every visible surface said it
worked** — a plugin list with states, an "applies to this download" panel, log
lines from `setup()` — and `setup()` running is exactly what makes a plugin
*look* alive. The only observable difference between "the hook fired and did
nothing visible" and "the hook never fired" is a plugin written to say so.

So the per-download switch is two changes: the pipeline now dispatches all six
points, and `jobs.plugins_off` carries the opt-out through the runtime's single
eligibility check.

⚠️ **Off only, and the asymmetry is real rather than unfinished.** A plugin
that is off server-wide is never activated, registers no hooks, and has nothing
to dispatch to — "on for this one download" would be a fourth control in
`DISCOVERIES.md` that moves and changes nothing. The panel says so instead of
drawing it.

### 🔴 The live queue stopped showing new work past 200 jobs

Found while giving `GET /api/jobs` a server-side sort. The SSE watcher built
every frame from `queue.list({ limit })` — the *queue's* order, priority then
**oldest first**, because that is the order `claimNext` works in. So on a
server with more than two hundred jobs the live snapshot was the two hundred
oldest rows, all long finished, and a download started today did not appear in
the Queue at all.

The snapshot is now everything unfinished plus the newest terminal rows. Two
queries rather than one ordered by status rank, because `done` (6) ranks above
`failed` (7) and a long history of successes would push every failed job off
the end — the rows somebody actually needs.

### The reported item: the screens sorted the page they had been given

`sort`, `order`, `q`, `bucket` and a status list are the database's work now,
and the answer carries `total` plus counts by status and by bucket. Past two
hundred jobs "the largest failed download" used to mean "the largest of the
latest two hundred" with nothing on screen marking the difference; the tiles
counted the fetched page the same way.

`core/job-buckets.ts` holds the Downloads-tab rule **once**, as a predicate,
with the SQL beside it in `job-buckets-query.ts` — split because the browser
imports the predicate, and a schema import in that graph drags `bun:sqlite`
into the client bundle (a trap this file already records). A test runs one
corpus through both and asserts they partition it identically.

`sortJobs`, `matchesText` and `matchesStatus` are **deleted**, and their tests
with them: a suite still passing over unused functions reports coverage of
behaviour nothing runs.

### The four smaller ones

| | |
|---|---|
| **`FFMPEG_BIN` reaches yt-dlp** | As `--ffmpeg-location`, and **resolved** rather than forwarded: yt-dlp answers a location that does not exist by continuing *without* ffmpeg, so a typo would disable the merge `PATH` would have served. A third trap fell out of it — given a file, yt-dlp derives every other program as `dirname/<program>`, so an ffmpeg with no ffprobe beside it takes ffprobe away. The boot log names which of the three cases happened |
| **`notifications` retention** | Two rules every six hours. Age removes *read* rows; a ceiling is what actually bounds the table, because the age rule spares unread ones and a bell nobody opens defeats it entirely. The ceiling spends read notifications first and says so in the log when it reaches an unread one |
| **Priority is changeable** | `POST /api/jobs/:id/priority` and a select in the inspector. 409 on a finished job: priority is an instruction about *when work happens* and a done job has no "when" left |
| **Auto-generated subtitles can be refused** | Off removes the language rather than downgrading it. The filter runs *before* the pick — filtering after would let a machine track win its language on rank and then be dropped, so a language with both kinds would come back empty |

### What was verified, and how

Everything here was driven against a **running server** rather than only in
tests: 450 seeded jobs through the real screens in a browser (tiles over the
whole table, "Jobs (200 of 450)", a search finding one row out of 450, a deep
link to the oldest job opening its inspector); the same URL queued twice from
the same form with the plugin switch off and on; a retention sweep on a live
instance removing 12 rows and keeping all 5 unread ones.

⚠️ And one mistake worth recording: a new test called `openDb(path)` instead of
`openDb({ path })`. `bun test` transpiles without type-checking, so it ran —
and the string's `.path` was `undefined`, so the fallback opened the
development database in `./data` and the sweep deleted rows out of it. `openDb`
now throws on a non-object argument. See `DISCOVERIES.md`.

---

## 2026-08-27 — Transcoding has a screen, and it says what it costs

> «la transcodificación existe entera en el servidor y no hay ni un botón.»

The queue, the presets, the progress and the cancellation landed earlier the
same day with **no UI at all** — deliberately, because three other agents held
the screens. This is the other half: a **Conversions** tab on the Library, a
*Convert…* button on the detail panel, and multi-select in the grid and the
list so a batch is one press.

**+27 tests (971 → 998 in the tree). `tsc` clean. React Doctor 60/100 with
nothing in a file this work created or touched.** Not committed.

### What it says, and where the words come from

🔴 **Every claim on this screen is the server's sentence, not a second one
written in the browser.** `core/transcode.ts` puts `cost` on the preset and
`api/transcode.ts` puts `concurrency` on `/presets` and a `warning` on the
`POST` answer *precisely so a UI does not invent them* — so the dialog renders
`preset.cost` verbatim, the receipt renders `warning` verbatim, and a rejection
renders the reason the route composed.

| The thing that must be understood | How it is said |
|---|---|
| **It re-encodes, and it is expensive** | A standing warning contrasting it with playback — which *remuxes*, copying the video — plus the preset's own `cost` line under every option, and a `Re-encodes the video` / `Copies the streams` badge from `reencodesVideo` |
| **One at a time** | `concurrency` from `/presets`, the count already waiting *before* the button is pressed, and — the part that matters — **"1 conversion ahead of it"** on every waiting row |
| **The original is never overwritten** | Said in the dialog, and then *shown*: every row carries both filenames. `replaceOriginal` is offered, off, and worded as what it is — the original is **moved to `.trash/` after the copy is verified**, restorable, and untouched if the job fails or is cancelled |

🔴 **Five rows reading "Waiting" is what this feature looks like when it is
working**, and rendered as a bare status it reads as five things that have
stopped. The queue position is the whole difference between a queue and a
stall, which is why it is a tested pure function rather than a string in a
component.

### What was built

| Where | What |
|---|---|
| `web/data/transcode.ts` | The four hooks. **Polled, not pushed** — `/api/events` is the download queue's stream and knows nothing about transcodes — at 1.5 s while something is active and 15 s when not |
| `components/library/transcode-view.ts` | Order, queue position, progress, the batch summary. Pure, **+27 tests** |
| `components/library/TranscodeDialog.tsx` | The presets, the three warnings, the receipt with `queued` **and** `rejected` |
| `components/library/TranscodeJobs.tsx` | The list, the progress bar, cancel-with-consequences |
| `components/library/{FolderSidebar,LibraryToolbar}.tsx` | Lifted out of the screen — see below |
| `screens/Library.tsx` | Three tabs, selection mode, the Convert button, and `useSetSearch` |

⚠️ **No ffmpeg flag is reachable from the browser, by construction.** The
dialog sends a preset id off the list the server sent; there is no free-text
field anywhere in it, which is the same rule the route enforces from its side.

### Two things fixed while in there

- **The Library was the seventh screen with the scroll bug.** Every navigation
  now goes through `useSetSearch`. Measured on the running app: scrolled to 218,
  opened an item, still 218. ⚠️ It cost a compile error first — see
  `docs/DISCOVERIES.md` on `interface` and `Record<string, unknown>`.
- **`trash: boolean` became `tab: "media" | "conversions" | "trash"`.** Two
  independent booleans would have had an impossible combination between them.
  ⚠️ `?trash=true` still opens the Trash: the router reads it as the *default*
  for `tab`, so an old bookmark does not silently land on the media grid.

### Verified in a browser against a real ffmpeg, not only in tests

A scratch library of VP9/Opus MKVs, `PORT=8703`, a real `ffmpeg` and `ffprobe`:

| | |
|---|---|
| A 12 s clip → `tv` preset, watched to `Done` | `ffprobe`: **H.264 High, level 40, `yuv420p` + AAC-LC 48 kHz stereo**, `moov` immediately after `ftyp`, duration 12.007 s against the source's 12.008 |
| The original | **still there**, same bytes, same mtime — in every one of these runs |
| Two queued at once | One `running` at 3 → 19 → 39 %, the other `queued` at 0 with *"1 conversion ahead of it"*, until the first ended |
| Cancel at 58 % (and again at 38 %) | ffmpeg killed, `cancelled`, **the partial `.mp4` deleted**, the source untouched, and the waiting job started by itself |
| A batch of two where one output already existed | *"1 file queued; 1 could not be"*, with the server's sentence: *"Videos/Short Clip (TV).mp4 already exists…"* |
| `replaceOriginal` on an `audio` conversion | `Second Clip.m4a` written, `Second Clip.mkv` in `.trash/` with `reason: "transcode"`, restorable from the Trash tab |

Light and dark, and at 1024×768 for the iPad: the selection ticks are 24 px and
sit on their own background, because they are drawn over a picture.

### One thing worth keeping

⚠️ **`row.status` is a `string`, not `TranscodeStatus`** — the column is a plain
`text()` with no `$type<>()`. Every lookup in `transcode-view.ts` is keyed on
`string` with a fallback, and there is a test for a status this build has never
heard of; the exhaustive version type-checks and renders `undefined` on the one
row that would matter.

📌 **React Doctor caught the screen growing.** `LibraryScreen` was not flagged
at `HEAD` and was flagged with this work on it — verified by running the scan
against a copy of the tree holding `HEAD`'s version of that one file. The
sidebar and the toolbar came out into `components/library/`, and the finding
went with them.

---

## 2026-08-27 — Credentials, on a screen at last (and `CREDENTIALS_KEY` in the deploy)

The store, the encryption and the four endpoints landed earlier the same day
and **nothing in the browser could reach any of them**. Asked where the cookies
go, the honest answer was *nowhere*. Now they go in Settings → Credentials.

**Only `screens/Settings.tsx` (one import, one card), new files under
`components/settings/` and `data/credentials.ts`, plus one appended key in
`data/keys.ts`.** +31 tests. `tsc` clean, bundle builds, React Doctor unchanged
at 59/100 with one deliberate finding in the new code (see below).

### What the screen says out loud, because it has to

🔴 **`encryption.enabled`, in the same element as the claim.** With
`CREDENTIALS_KEY` set: a green *"Encrypted at rest — aes-256-gcm, key derived
by PBKDF2-HMAC-SHA256, 210000 iterations, under key `3a765cce`"*. Unset: a red
panel carrying **the server's own `warning` string**, and the sentence the
mockup promised is simply not drawn. Same rule inside the form, where the paste
actually happens. Verified in a browser both ways, by restarting the server
with and without the variable.

🔴 **The cookie notice sits beside the cookie box** — the server's `notice`,
verbatim, not summarised — and repeats under the list whenever a cookie
credential is on screen. It is the screen someone comes back to when yesterday's
download stops working today.

🔴 **The list is numbered and says the numbering is the resolution order.** The
API already sorts most-specific-first; a precedence list that does not say so is
a list somebody re-sorts by date one day.

### What makes a row readable

`cookieCount`, `domains`, `sessionCookies` and `expiresAt` for a jar;
`username` for a login; `fields` (names only) for a key. Without them, two jars
for youtube.com are the same line twice. The expiry thresholds are deliberately
impatient — a fresh YouTube jar reads *"First cookie expires in 4 h"* in red,
because that is the truth about it and green would be a lie by omission.

⚠️ **Nothing suggests a secret can come back.** No masked field, no "reveal",
no prefill. Replacing means pasting again, and the dialog says so.

### Verified in a real browser, with the network panel instrumented

`window.fetch` was wrapped before any page JS, so every response **body** was
captured, not just the request list. One credential of each type created (a
cookies jar by **file upload**, a login, an API key, a two-field custom), each
tested, each deleted, with and without a key.

- **122 responses captured, 0 containing any of the 8 planted secrets** — and
  the search was proved able to see them first, by planting one in the captured
  list and finding it. Instruments lie; this one was checked.
- The only field that echoes anything is `username`, which is metadata by
  design (it is what tells two accounts apart) and is documented as such.
- The 422 path renders the server's sentence intact:
  *"That credential was rejected (cookies): line 3 is separated by spaces, not
  tabs…"* — field named, line named. The form warns about that same paste one
  second earlier, without a request.
- Delete asks first and says what cannot be undone; the empty state and the
  cookie notice both come back correctly afterwards.
- Light and dark, 1180 px and 820 px (iPad). No console errors.

### 🔴 The bug this work found: a value import from `core/` kills the bundle

`import { CREDENTIAL_TYPES } from "../../../core/credentials"` type-checks
perfectly and **breaks `Bun.build`** — `verbatimModuleSyntax` erases
`import type` but not a value import, which drags `bun:sqlite`, drizzle and the
`bun` builtin into a browser target. The server log says exactly
`client bundle failed: Bundle failed`, the API keeps answering, and the app is a
blank error page. Full entry in `docs/DISCOVERIES.md`.

### Outside the frontend: `CREDENTIALS_KEY` is now in the deployment

It was in neither `docker-compose.yml` nor `docs/DEPLOY.md`, so **a default
deployment stored cookies in plain text and nobody was told**. Both now carry
it: how to generate one (`openssl rand -base64 48`), that unset means plain
text, that changing it re-encrypts nothing (each row records the key that
sealed it, the Test button names it, the fix is to paste again), that losing it
loses only the credentials, and that `/data` is a copy of your cookies while the
key deliberately is not in it. The "Sign in to confirm you're not a bot"
troubleshooting now points at the screen rather than at `COOKIES_FILE`, which is
demoted to what it is: the global fallback that any matching credential beats.

### Left as it is, on purpose

- **Array index as a key** on the custom-fields rows is React Doctor's one
  finding in this code and it stays: those rows have no identity, and a key
  from the typed name remounts the input on every keystroke, losing the caret.
- **No editing.** The API cannot return a secret, so an edit form could only
  ever be a new paste with the old metadata drawn around it.
- `apiKey` and `custom` are offered with the sentence that nothing built in
  reads them, rather than quietly.

---

## 2026-08-27 — *Archivado* stopped being a guess

> The Downloads screen badged a finished job **Filed**, and its own tooltip
> admitted what that meant: *"whether it is still on disk is not checked — a
> file deleted outside CasaTube still reads as filed."* That was written down as
> a limitation the same day it was built. It was a fault: the screen showed a
> fact **adjacent** to the one it was asked for.

Now the disk is actually consulted, and a file removed behind CasaTube's back
reads **File gone** — with a button that downloads it again.

**+61 tests (935 → 996 across 39 files), `bunx tsc --noEmit` clean, React Doctor
59/100 with nothing reported in any file this touched** (67 warnings, down from
71: four were mine and are gone — see below).

### The five states, and the one that carries the weight

| | |
|---|---|
| `present` | on disk, at the recorded path, when the check ran |
| `missing` | the library answered and there is nothing there |
| `trashed` | in CasaTube's own trash — restorable, and the entry id travels with it |
| `none` | finished, and no path was ever recorded |
| `unknown` | nothing could be established, **and the reason says what stopped it** |

🔴 **`unknown` outranks `missing` whenever the evidence is not conclusive**, and
that is the whole design. Telling someone their download is gone when the NAS is
merely asleep is a lie told with confidence — worse than the silence it replaces.

### 🔴 The design decision: a route of its own, not a field on the job row

The obvious version is a `fileState` computed while `GET /api/jobs` builds its
listing. It is wrong **here**, for a reason specific to this application:

**`GET /api/jobs` and the SSE stream are the same payload.** `api/watcher.ts`
re-reads the job table every **750 ms** and pushes a whole snapshot to every open
tab, and `web/data/stream.ts` writes that snapshot straight into the same React
Query entry the listing fills. A `fileState` on the job row is therefore not
"200 stats when the page loads" — it is **200 stats per second, for as long as a
tab is open**, against a network mount. Leaving it off the pushed frames instead
makes every badge flicker from checked to unknown twice a second.

So: **`POST /api/jobs/file-state`**, taking the ids of the finished jobs on
screen, with its own React Query entry keyed on those ids.

- **Ids, not paths.** The browser has never been told where the library root is,
  and `Job.outputFile` is absolute. The translation is the server's
  (`core/file-state.ts` → `libraryRelativeOutput`), so no browser-supplied path
  is ever `stat`ed — and a root that has *moved* (`/library` in a container,
  `/mnt/nas` on the host) still resolves, via `destination` + filename.
- **It never fails because of the disk.** A dead mount is a **200 full of
  `unknown`**, not a 503: the caller is drawing a badge per row and needs an
  answer for each one.
- **Bounded**: one root check, one trash read, and a pool of at most 16 `stat`s
  under a 3 s budget for the whole batch. Anything unanswered when it expires is
  `timed-out` — never `missing`.
- **Splitting the route splits the failures**, which is the part that matters
  when the library is asleep: the queue is local SQLite and keeps answering while
  this one says "could not check".

Measured against a running server, 200 jobs, single instance (see the
`SO_REUSEPORT` note below — the first numbers were taken with two):

| | |
|---|---|
| `GET /api/jobs`, 200 jobs | **16 ms** warm, 40–59 ms cold |
| `POST /api/jobs/file-state`, ~175–199 ids → one `stat` each | **2–5 ms** server-side, **8–13 ms** round trip (nine warm samples; the outliers are 10 ms / 22 ms) |
| Same, first call after a restart | 13–26 ms server-side |
| `file-state` requests during **20 s of live SSE** | **0** — verified with a positive control |

### 🔴 The three gates that keep `missing` honest

`core/library.ts` → `presence()`. Each gate exists because of a real way a
library disappears, and the second one is the one nobody thinks of:

1. **The root did not answer** — `LIBRARY_DIR` pointing nowhere, the mount
   unreachable, permissions removed → everything is `mount-unavailable`.
2. **The root answered and is completely empty**, while we were asked about files
   in it → `library-empty`. ⚠️ **An NFS mount that failed to mount leaves the
   mountpoint directory behind**, so the root `stat`s perfectly and every file
   under it is `ENOENT`. Gate 1 cannot see that; this one can. It misreads a
   genuinely emptied library as unknown, which is the direction to be wrong in.
3. **Per path, on its own errno.** `ENOENT`/`ENOTDIR` are the *only* two that
   mean absence. `EACCES` and a timeout are `unknown`.

And a fourth, in `core/file-state.ts`: a file absent from its path **whose trash
could not be read** is `unknown`, not `missing` — the one thing that would tell a
deletion made here from one made behind our back is the thing that did not answer.

**The disk decides before the trash.** The journal is authoritative about
deletions, not about the present, so it is consulted only to *explain an
absence*. A re-download over a trashed name therefore reads `present`, not
`trashed` — there is a test for exactly that.

### Verified in a browser, against a real disk

`PORT=8702` with its own library. A file `rm`'d from the shell → **File gone**;
one deleted through the API → **In trash**; the rest → **On disk**. Then
`LIBRARY_DIR` pointed at a path that does not exist → every row went to a neutral
grey **Not checked** with *"the library root … is not there"*, **no red badges
and no alarm**. The same directory created but left empty → `library-empty`,
still not `missing`. Light and dark, and legible at 1024 px.

Re-download clicked from the panel: a **new** job, `queued`, same URL, same
destination, same resolved `preferences` (1080p), with the original row untouched.

### What changed

| Where | What |
|---|---|
| `core/library.ts` | `presence(paths, { budgetMs, concurrency })` — never fails, one verdict per path |
| `core/file-state.ts` | **new**. Job + trash + presence → the five states, and `libraryRelativeOutput` |
| `core/types.ts`, `core/queue.ts` | `JobFilter.ids`, so one query answers for a batch (`[]` matches nothing) |
| `api/jobs.ts` | `POST /file-state` and `POST /:id/redownload` |
| `search-params.ts`, `router.tsx` | `FILE_FILTERS` gained `present`, `missing`, `unknown`; `QueueSearch.file` |
| `components/jobs/job-order.ts` | the client-side derivation **deleted**, not duplicated; what is left is matching an answer to a row |
| `components/jobs/JobFilters.tsx` | five badges, a re-check button carrying *when* and *how long*, per-reason sentences |
| `components/jobs/JobInspector.tsx` | the File row, the "not there any more" panel, **Download it again** |
| `screens/{Queue,Downloads}.tsx` | both filter by file state; Downloads counts the missing ones above the table |

**Both screens moved to `useSetSearch`.** They were the last two calling
`navigate({ search })` by hand, which is the scroll-to-top bug one copy at a
time. Measured: `scrollY` 4000 → 4000 across a row click, 3000 → 3000 across a
re-check.

### Three things found by doing it

**🔴 `SO_REUSEPORT` bit again, and it invalidated a measurement.** A `nohup … &`
whose *following* command failed still started a server; `kill`ing the pid I had
written down left it running, and Bun happily bound a second server to 8702. The
kernel round-robined between a server pointed at the real library and one pointed
at a path that does not exist — so "the mount is down" returned `present`. It is
already in `docs/DISCOVERIES.md`; the new part is that `ss -lptn` shows **two
rows for one port**, and that is the check.

**A `useMemo` over `data ?? []` never memoises anything.** `jobs.data?.jobs ?? []`
is a fresh array on any render without data, so `useMemo(..., [all])` re-runs
every render — React Doctor flags it as a dependency that lies. Both screens now
call a plain one-pass `finishedIds(jobs)`; the query key is a *string*, so the
array's identity was never the thing that mattered.

**`describeCause` said `EACCES: EACCES: permission denied`.** Bun already puts
the errno at the front of the message. Harmless until that string became a
sentence in a badge tooltip.

### Left open, deliberately

- **The check is not on a timer**, on purpose: a file does not vanish while you
  watch it. It refetches on mount, on window focus, and on the button.
- **A library that someone really did empty reads `unknown`**, not `missing`.
  That is gate 2 choosing the safe direction; there is no signal that separates
  it from an unmounted mount, and the note says so rather than pretending.
- `POST /api/jobs/file-state` caps at **500 ids**, which is the same page the
  jobs route caps at. Past that the answer is about the page, like the sort.

---

## 2026-08-27 — The 438 MB video, answered; and transcoding as a queue

Two things: the file that would not play, diagnosed and fixed, and an optional
re-encode that is a job rather than a request.

### 1. 🔴 The cause: a **fragmented** MP4, not a big one

`Videos/My Secret Agent Husband EP.mp4` is not `moov` + `mdat`. It is `mvex`
plus **1475 `moof` fragments** with no index and `mvhd.duration = 0`, so a
browser has to read every fragment before it can play a second. Measured in a
real Chrome with the network panel open, at `preload="metadata"`, before one
frame: **468 range requests and 3.74 GB on the wire** — 8.7× the file. On
loopback that is twelve seconds of spinner; over the tailnet it is the bug.

⚠️ **Size was the plausible wrong answer, and it was tested rather than
adopted.** The same 73 minutes remuxed to a plain MP4 — same codecs, same
439 MB — is **one request and 11.8 MB**. So no size threshold was added to
`direct`; one would have punished every large file and still missed a fragmented
small one. Full numbers in `docs/DISCOVERIES.md`.

**What changed**

- `core/hls.ts`: `readMp4Layout()` walks the top-level boxes of the first 256 KB
  and reports whether `moov` declares `mvex`. `decidePlayback` takes it as a
  third, optional argument and routes a fragmented MP4 to **HLS**. Read once per
  (size, mtime), behind the same cache as the probe; unreadable head → no
  opinion, and the old behaviour stands.
- `api/library.ts`: an open-ended `Range: bytes=N-` is answered with at most
  **4 MB** for inline playback. ⚠️ **Never for `?download=1`** — a resumed save
  must get the rest of the file, or it is a silent truncation.
- `src/web` (the only change there, and it is the player): the detail panel now
  asks `GET /api/library/hls/playback` instead of guessing from the extension.
  The extension guess stays as the fallback until the verdict arrives.

**Verified in the browser, not in a test.** After the change the same file
starts in **5.9 MB** — index plus five segments — plays, and seeks to 40:00. The
plain 439 MB MP4 still goes `direct`, plays and seeks with the cap in place.

### 2. Transcoding — optional, one at a time, never over the original

New: `core/transcode.ts`, `api/transcode.ts`, table `transcodes`
(migration 0006). **A job in a queue, not an HTTP request that waits**, so it
inherits progress, retries, cancellation and survival across a restart.

| | |
|---|---|
| `GET /api/transcode/presets` | Four named outcomes, each carrying **what it costs** and `reencodesVideo` |
| `POST /api/transcode` | One file or a batch. Returns immediately; a batch answers with `queued` **and** `rejected`, per file |
| `GET /api/transcode` | What is queued, running and finished |
| `DELETE /api/transcode/:id` | Cancel a queued job, or kill the running one and remove the partial file |

🔴 **One at a time, always** (`concurrency: 1` is in the response so a UI does
not have to infer it) — this box also runs Home Assistant and Zigbee.
🔴 **Never over the original**: the output is a new file beside it, `-n` not
`-y`, and a preset that would land on the input is refused at enqueue.
`replaceOriginal` is opt-in and even then the original is **moved to `.trash/`**
after the copy is verified.
🔴 **Presets, not flags**: the route takes an id off a fixed list, so the only
ffmpeg that can run is the ffmpeg written in `core/transcode.ts`.

**Verified with a real ffmpeg**, not only the fake one in the tests: a VP9/Opus
MKV (verdict `unsupported` — nothing can play it) → `tv` preset → `ffprobe` says
H.264 High level 40 `yuv420p` + AAC-LC stereo 48 kHz, `moov` first, duration
unchanged, original untouched, and the new file's verdict is `direct`. A batch
of three ran one at a time with one clean rejection. A real 73-minute encode was
interrupted by `SIGTERM` (requeued, attempts untouched, no ffmpeg orphan),
resumed on restart, and cancelled through the API (killed, partial file removed).

⚠️ **A bug this found**: killing our own ffmpeg on shutdown was being read as
ffmpeg failing — `attempt 1/2 failed: ffmpeg exited with code 255`. Two deploys
would have killed a long encode for good. See `docs/DISCOVERIES.md`.

### Not done, deliberately

**There is no transcode UI.** Three other agents held
`screens/{Dashboard,Queue,Downloads,Settings}.tsx` this session and `src/web`
was limited to the player. The cost warning and `concurrency: 1` are in the API
answers precisely so whoever builds the screen can show them without inventing
wording. That screen is the next piece of work.

---

## 2026-08-27 — The queue reads newest-first, filters for real, and stops jumping

> «el orden por defecto empieza por lo más viejo… y la página vuelve arriba.»

Five things found by using it. Only `screens/Queue.tsx`, `screens/Downloads.tsx`
and new files under `components/jobs/` — plus two additive edits noted below.

### 1. The order was backwards, and it was the API's order

`GET /api/jobs` returns **priority first, then oldest first**. That is exactly
right for a worker deciding what to claim next and exactly wrong for a person
reading a queue, and both screens were rendering it raw. Both now default to
`sort=date&order=desc`.

### 2. Sorting and filtering, in the URL

`components/jobs/job-order.ts` — pure functions, so they are testable, which is
the only reason any of this is covered at all (there is no DOM harness here).
**+25 tests.**

- Sort by date, status, priority, size or duration, either direction.
- 🔴 **Unknowns sink in both directions.** A job with no reported size is not a
  0-byte job; flipping largest-first to smallest-first must not promote "we
  don't know" to the top of the screen.
- The order is **total** — ties break on `createdAt` then `id` — so an SSE frame
  arriving mid-read cannot shuffle equal rows.
- Status filter and free-text search (title, URL, output filename, destination).
- All of it in typed search params (`sort`, `order`, `q`, `file`), so a view is
  a link and survives a reload.

⚠️ **Client-side over the 200-job page the API already sent.** See "What the
server does not have" below.

### 3. The scroll jump was the router, not React

Not a remount, not a re-key, not focus — **TanStack Router calls
`window.scrollTo(0, 0)` after every navigation unless told otherwise**, and a
search-param change is a navigation. Every `navigate` on these two screens now
goes through one `setSearch` helper that passes `resetScroll: false`.

📌 Every *other* screen still has the bug: the Dashboard's range selector was
measured jumping 448 → 0 in the same build. `docs/DISCOVERIES.md` has the
mechanism and the measurements.

### 4. What became of the file, on the row

Downloads badges a finished job **In trash** / **No file** / **Filed**, with a
matching filter. The trash is cross-referenced against
`GET /api/library/trash` — one cheap request, and the journal is authoritative,
so an entry in it is proof and its absence is proof of absence.

🔴 **There is deliberately no "missing".** Nothing on the wire says whether a
recorded output path still exists, so "Filed" claims only what is true —
*CasaTube put it there* — and the tooltip says a file deleted outside CasaTube
still reads that way. When the trash cannot be read, every state becomes
`unknown`, the badges disappear and the filter is disabled rather than silently
emptying the table.

### 5. Metrics before the list

They were under the Downloads table, which is where the numbers you check first
go to never be seen.

### And the Batch add note Santi flagged

"Every URL is queued with the same settings" was true about the *request* and
misleading about the *result*: batch add sends no per-link options at all, and
what comes out is whatever each source happens to have. It now says which half
is shared (destination, priority) and points at the single-URL form for the
other half.

### What the server does not have

- 🔴 **No file-state on a job.** No `outputFileExists`, and no batch "do these
  paths exist" route. `GET /api/library/item?path=` would answer for one path;
  a completed tab of 128 rows would be 128 stats against a network mount, so
  the UI does not guess. A `fileState` field filled in at list time — or
  `POST /api/library/exists` taking paths — is what would make "missing" real.
- **No sort, order or search on `GET /api/jobs`.** It takes `status`, `limit`
  and `offset` only, so sorting and searching are over the returned page.
  Past 200 jobs "the largest failed download" becomes "the largest of the
  latest two hundred", which is a different sentence.
- **No priority change endpoint** (already known), so the priority column and
  the priority sort are read-only.

### Two files touched outside the new ones

- `JobTable` gained one **optional** `badge?: (job) => ReactNode` prop rendered
  beside the status pill. Nothing else passes it, and `JobList` — what the
  Dashboard uses — is untouched.
- `search-params.ts` / `router.tsx` gained `JOB_SORTS`, `SortOrder` and
  `FILE_FILTERS`, additively; every existing param validates as before.

---

## 2026-08-27 — Credentials, per site and per type

**Tests: 68 new, all green. `bunx tsc --noEmit` clean.** Not committed.

### The gap this closes

There was exactly one way to authenticate anything: `COOKIES_FILE`, a single
jar for the whole process. Enough for one YouTube account, and nothing else —
so age-gated video, members-only uploads and the *"Sign in to confirm you're not
a bot"* challenge were all unreachable for any site that is not the one that
variable happens to point at, and a site wanting a username and password had no
answer at all.

### What was built

`src/core/credentials.ts` — the store. A credential is a **scope**
(`youtube.com`, `*.odysee.com`, `*`), a **type** (`cookies` | `password` |
`apiKey` | `custom`) and a secret. Resolution is **most specific wins**:
`www.youtube.com` beats `*.youtube.com` beats `youtube.com`… beats `*`.
New `credentials` table, migration `0005_sudden_domino.sql`.

`src/api/credentials.ts` — `GET /api/credentials`, `POST /api/credentials`,
`DELETE /api/credentials/:id`, `POST /api/credentials/:id/test`.

`src/providers/ytdlp.ts` — `probe`, `list` and `fetch` each resolve a credential
for their URL, run with it, and release it in a `finally`. Cookies become
`--cookies <file>` (0600 in a 0700 temp directory, deleted after the run);
passwords become `--username` / `--password`.

### Three decisions worth keeping

**🔴 One-way by construction, not by discipline.** The store's read methods name
their columns and never load `secret`, and every route answers with a type that
has no field a secret could travel in. An endpoint that returns cookies is not
something a future route can write by accident — it would have to be written on
purpose, against the shape of the module. Verified negatively: the tests
serialise each response and search for the exact bytes that were posted.

**⚠️ No key means plain text, said out loud.** `CREDENTIALS_KEY` derives an
AES-256-GCM key (PBKDF2-HMAC-SHA256, 210k iterations, random salt per
credential, WebCrypto throughout). Unset, the server prints a three-line warning
at startup, every write logs one, `encrypted: false` travels in the metadata and
every listing carries the reason. The Settings mockup promises *"Cookies are
encrypted at rest"*; faking the encryption would have made that sentence a lie
nobody could see.

**Validate the jar at the paste, not at minute twenty.** A `cookies.txt` is
parsed before it is stored — field count, `TRUE`/`FALSE` flags, numeric expiry,
`#HttpOnly_` handled as a domain prefix rather than a comment — and the summary
it produces (count, domains, soonest expiry) is what lets the test endpoint say
*"expired yesterday"* or *"this jar is for youtube.com, not odysee.com"*
**without touching the network**. Two entries in `docs/DISCOVERIES.md` came out
of this.

### Verified against a running server, not only in tests

`PORT=8691 bun src/server.ts`, both with and without `CREDENTIALS_KEY`: the
startup warning appears and disappears, a mangled jar is a 422 naming the line,
the secret is absent from every response, and the raw SQLite bytes carry
`aes-256-gcm` and neither the cookie value nor the password. ⚠️ That last check
had to grep the **WAL** as well as the `.db` — see DISCOVERIES.

### Left open, deliberately

- `apiKey` and `custom` are stored, described and tested, but **no built-in
  provider consumes them** — yt-dlp has nowhere to put an API key. The test
  endpoint says so rather than implying they work.
- `--password` puts the password in **argv**, visible in `ps`. yt-dlp has no
  file-based alternative short of `.netrc`. Reported, not hidden.
- There is no re-encrypt-everything command for a rotated `CREDENTIALS_KEY`.
  Today the store says which key sealed each row and tells you to re-save.

---

## 2026-08-27 — Plugins stopped being a file you copy in

> «hoy hay que soltar un fichero en una carpeta y reiniciar.»

Three things, and each one turned out to be the same complaint from a different
angle: a plugin was a thing you had to already know about. You had to know the
directory, know which environment variables it read, and know to restart.

Now: **write one in the browser**, **fill in a form the plugin itself
described**, and **three real plugins arrive on first boot**.

**+61 plugin tests (45 → 106 across five files). `tsc` clean.** The whole suite,
with the other agents' work of the same day in it, is 867 passing / 0 failing.
React Doctor **60 / 100**, against 57 recorded before this session; nothing this
work added is on its list, and both remaining errors are in vendored Dice UI
code.

### 🔴 The bug this uncovered: reload never reloaded

`plugin-runtime.ts` had reloaded by importing `plugin.ts?g=<generation>` since
the day it was written, with a comment explaining that the query string was what
made an edited plugin take effect.

**It never did.** Bun keys its module registry on the resolved path and drops
the query — and the hash — from a `file:` URL. Every reload after the first
handed back the first evaluation, silently, with the new source sitting on disk.

It was invisible for as long as it existed, because nobody edits a plugin
without also restarting the process. Adding an editor is what turned a dormant
bug into *the main feature not working*. Each file is now imported through a
hidden sibling copy that is deleted immediately; see `docs/DISCOVERIES.md` for
the measurements and for why a sibling rather than a temp directory.

### 1. An editor, on the Settings screen

**CodeMirror 6**, chosen against Monaco (≈5 MB and a second copy of the
TypeScript compiler in the browser, for a bundle smaller than its language
service), Ace (pre-ESM, unmaintained React wrapper) and a Prism-painted
`<textarea>` (~10 kB, and no bracket matching or indentation — in a box where a
missing brace *is* the failure this screen displays). CM6 is ~250 kB, pure ESM,
no workers, and `Bun.build` takes it untouched.

`GET/PUT/DELETE /api/plugins/source`, and every write **reloads the runtime**.

⚠️ **A broken save answers `200`, and that is not sloppiness.** The write
happened; the failure belongs to the *plugin*, and it comes back as
`saved.state: "error"` with the reason, alongside the full listing showing
everything else still loaded. Verified in a browser: a syntax error typed into
the box left jellyfin, unshorten and webhook `active`, and the file was
reopened, fixed and saved from the same dialog.

🔴 **Files are addressed by filename, never by plugin name.** A file that does
not parse has no manifest and therefore no name — and it is precisely the file
someone needs to open.

⚠️ Every save carries a warning generated by the server about what has just been
given permission to run, on **every** save rather than the first. Capabilities
are a UI contract, not a sandbox (PLAN §5); an editor makes running code one
text box away, which makes that sentence matter more, not less.

### 2. Plugins declare their settings, and the UI draws the form

`jellyfin.ts` used to read `JELLYFIN_URL` and `JELLYFIN_TOKEN` blind and, when
they were missing, log one line and do nothing. Correct, and useless — the only
way to learn what to set was to read a file that was not on the screen.

`settings: [{ key, label, description, secret, default, required, type, options }]`
is static metadata like `matches`, so **the form exists before `setup` has ever
run**. Values are rows in the `settings` table, which had been in the schema
since the first migration with nothing writing to it.

Four layers, and `core/plugin-settings.ts` is the single author of the order:
**stored** (the form) → **file** (`plugin-state.json`) → **environment** →
**default**. Nothing ever writes to the environment, which is what makes the
*"use the environment value"* button honest rather than a second guess — and the
button is only offered when there is a layer underneath that would actually
answer. Verified end to end in a browser against a real `JELLYFIN_URL=…`.

🔴 **A secret never leaves the server.** `redact()` and `redactDeclarations()`
are applied to everything the route emits — the settings endpoint, the listing,
and a secret's *declared default*, which is the hole the obvious version leaves.
The test searches the whole serialised body for the string rather than checking
the one field somebody remembered.

⚠️ And a plugin's **own log** is API output. Nothing server-side can redact what
a plugin chose to print, so the README says not to log a secret and the test
plugin logs `TOKEN_LEN=7`.

⚠️ Stored **unencrypted**, in the same database as everything else. Exactly as
exposed as the same token in a compose file, which is where it was before — and
said out loud in the form rather than implied.

### 3. Three plugins from the factory

| | Kind | What it demonstrates |
|---|---|---|
| `jellyfin.ts` | observer | `matches: []`, a secret setting, an observer that throws on purpose |
| `unshorten.ts` | **transform** | real `matches`, replacing the value, and catching everything so a dead shortener cannot fail a download |
| `webhook.ts` | observer | two hook points at once, `job:failed`, and a select / boolean / number form |

They live in **`src/plugins/builtin/`**, not the repository's `plugins/` folder:
the image copies `src` and not the repository (`docs/DISCOVERIES.md`), and the
server has to read them to seed them. They are copied into `DATA_DIR/plugins/`
at boot, so they are ordinary files you can edit and delete.

🔴 **An edited built-in is never written over.** The seeder records the SHA-256
of exactly what it wrote, which is the only thing that tells four cases apart:
never seeded (write), seeded and now missing (you deleted it — leave it),
unchanged since we wrote it (an upgrade may land), and **changed** (yours wins,
and the boot log says the upgrade did not reach it). A silent overwrite of
someone's plugin is the worst thing this feature could do.

### 🔴 Found by clicking, not by reading

`useEffect(… , [open, name, save])` where `save` is a `useMutation` result — a
new object every render — is an infinite render loop. React ends it with error
#185 and the **whole Settings page** becomes an error boundary, from a dialog
nobody had opened. `tsc` is happy, and the exhaustive-deps rule pushes you
straight into it. Both dialogs now reach their mutations through refs.

### One more found by clicking: a save that erased its own receipt

Splitting the dialog into a shell and a `key`ed body fixed the render loop and
introduced a smaller bug in the same move: saving a *new* plugin told the parent
to start editing that filename, which changed the key, which **remounted the
body** — and took the "Saved to … active" panel and the server's warning with
it. The body remembers the name it wrote instead, and the parent is deliberately
not told. Verified by creating, saving twice (the second must overwrite, not
409) and deleting, all from the browser.

### Shared files touched

`src/server.ts` (seeding + the settings store), `src/web/data/keys.ts` (four new
cache keys, appended), `src/web/data/plugins.ts`, and `plugins/jellyfin.ts` was
**moved** to `src/plugins/builtin/jellyfin.ts`.

⚠️ New dependencies: `codemirror`, `@codemirror/lang-javascript`,
`@codemirror/theme-one-dark`, `@codemirror/state`, `@codemirror/view`,
`@codemirror/commands`. Loaded through `React.lazy`, so they are a separate
chunk and no screen but this dialog pays for them.

---

## 2026-08-27 — Usable end to end, and published

**566 tests, 0 failures.** Running in Docker and used for real.
Repository: <https://github.com/xantiagoma/casatube> (private).

### What works

Paste a URL → the form shows the resolutions, audio tracks and subtitles that
video actually has, with the original marked → queue it → watch the six stages
live over SSE → the file lands in the library, correctly language-tagged.

Eight screens on shadcn/Tailwind. Library with thumbnails, playback (HLS remux
on demand, with real seeking), downloads as video / everything / extras-only,
and a trash you can restore from. Sources, scheduler, storage, analytics,
plugins.

### Still to improve

- Priority change, settings write, watchlist as a concept and filename templates
  were reported as missing endpoints and never built.
- `react-doctor` sits at 57/100; most findings are in vendored Dice UI code.
- `notifications` grows until someone purges it — no automatic retention.
- `Preferences` cannot refuse auto-generated subtitles.
- `FFMPEG_BIN` never reaches yt-dlp, which finds ffmpeg on `PATH` only.

### Two habits this project earned

**Verify the instrument, not just the result.** Again and again something passed
for the wrong reason: a test asserting on the thing next to the thing; `grep -c`
counting commented-out lines as enabled config; a paginated registry making a
published version look missing; a helper returning "unavailable" that turned a
content assertion into a test which always passed. The fix each time was to
break the code on purpose and check that the test noticed.

**Never substitute in silence.** HomeTube's language tags, a codec that does not
exist at the requested resolution, a subtitle failure taking a video down with
it, a bundle quietly shipping one file instead of three. Every one of them
looked like it was working.

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
