# Discoveries

Things that cost time to find, written down so they cost it once.

## Two ways a deploy tool lies, both found on the same afternoon (2026-08-28)

Neither of these is a CasaTube bug. Both nearly changed what got deployed.

### `casaos-cli app-management apply -f <file>` applies nothing

The appid is a **positional** argument — `apply <appid> -f <file>` — and the
obvious shape is silently wrong:

```
$ casaos-cli app-management apply -f docker-compose.casaos.yml
Error: accepts 1 arg(s), received 0     # ← stderr
$ echo $?
1
```

⚠️ It is honest in the exit code and silent on **stdout**: the usage text goes to
stderr, so a script that redirects stdout to a log and does not check `$?`
records an empty, clean-looking step that did nothing at all. `list apps` prints
the appids. And `apply` is asynchronous — inspecting the container immediately
after shows the old one, which is its own way of answering a question you did
not ask.

### An image's `Created` is not when that tag was built

```
casatube:wip     aa218434192f  2026-08-28 05:23:20 UTC
casatube:latest  21eb9bf995c4  2026-08-28 05:23:20 UTC
```

Two different images, same timestamp to the second — built eight minutes apart
from different source. `Created` describes layers, not history, so comparing it
against a commit date "proves" things that are not true. Here it produced a
confident, wrong conclusion that a migration had not shipped, and the correction
came from asking the thing itself: `__drizzle_migrations` had nine rows and the
columns existed.

📌 The shape both share is the one this file keeps re-learning. **A tool that
answered is not a tool that answered the question you asked.** `docker inspect`
gave *an* answer, so `docker images` — one command away, and the one that showed
the collision — was never run.


## `VOLUME` for a path nobody mounts is an anonymous volume per recreate (2026-08-28)

The Dockerfile declared `VOLUME ["/data", "/library"]`, which reads as harmless
documentation and is not. A `VOLUME` line means *"if nothing is mounted here,
make an anonymous volume"* — so the moment the deployment stopped mounting
anything at `/library`, every `docker run` left a fresh one behind. Six had
accumulated on ohana before anybody looked at `docker volume ls -f dangling=true`.

📌 The reason nothing mounts `/library` any more is the second half of this
entry. `LIBRARY_DIR` points at `/mnt/mailmedia/videos`, and the container binds
`/mnt/mailmedia` — the **parent**.

⚠️ **A FUSE mount must be bound by its parent, not by itself.** `videos` is an
rclone mount. Binding it directly captures the FUSE handle that existed when the
container started, so the first time rclone remounts, the container is holding a
stale one and the library reads as **empty** — not as an error. Binding the
directory above it with `propagation: rshared` lets the remount propagate in.
HomeTube did this, and it is why HomeTube survived remounts.

📌 So the rule for `VOLUME` is narrower than it looks: declare it only where an
*unmounted* path holds something worth keeping. `/data` qualifies — without the
declaration the database would live in the container's writable layer and vanish
on the next recreate, silently. `/library` never did: a library nobody mounted
is an empty directory nothing will ever read.


## `max-h-*` on a Radix `ScrollArea` gives you neither a max height nor a scroll (2026-08-28)

The notification bell spilled its list out of the popover and could not be
scrolled. Two symptoms, one cause, and the obvious-looking code:

```tsx
<ScrollArea className="max-h-96">   // wrong
```

The **viewport** is the element Radix gives `overflow: scroll`, and shadcn's
wrapper gives it `size-full` — `height: 100%`. A `max-height` on the root leaves
the root's height *indefinite*, so `height: 100%` on the child resolves as
`auto`: the viewport grows to the full height of its content. Measured with 40
rows:

| | |
|---|---|
| root `clientHeight` | 384 px (`max-h-96`) |
| viewport `clientHeight` | **3483 px** |
| viewport `scrollHeight` | 3483 px |

`scrollHeight === clientHeight`, so there is nothing to scroll — and the
viewport, being taller than the root, paints straight through it.

📌 The fix is to put the limit on the **viewport** (`viewportClassName` on our
wrapper), not on the root. A definite `h-96` on the root also works and is
worse: the panel is then 384 px tall for a list of two.

⚠️ Both callers in this repo had it. Worth remembering as a shape rather than a
line: **an element with `height: 100%` cannot be constrained by a parent's
`max-height`** — the percentage needs a definite length to resolve against.


## The move stage silently replaced files, and its own check confirmed it (2026-08-28)

Two videos whose titles clean down to the same name — a live set and its
re-upload, two talks called "Keynote", **the same video fetched twice at
different codecs** — produced *one* file. The second destroyed the first.

```ts
await rename(ctx.downloaded.file, target);   // POSIX: replaces silently
```

`rename(2)` replaces an existing target without complaint. That is the whole
bug, and it is one line.

📌 What made it invisible is the line underneath. The stage verifies its own
work — the right instinct, and the reason the file-state check exists at all:

```ts
const s = await stat(target).catch(() => null);
if (!s || s.size === 0) return Result.err(...)
```

After an overwrite there **is** a non-empty file at the target, so the check
passed. Both downloads reported success, both rows pointed at the same path, and
the earlier file was gone. A verification that asks "is there something there?"
cannot tell "we put it there" apart from "something else was already there" —
and the second is the case worth catching.

⚠️ The sidecars are the half that is easy to miss when fixing it. `Name.mkv`,
`Name.en.srt` and `Name.jpg` are one thing with one name, so:

- a stem is **taken by its sidecars**, not only by the video — a folder holding
  a lone `Name.en.srt` must not accept a new `Name.mkv`, which would silently
  adopt somebody else's subtitles;
- and they must follow the **final** name. `Talk (2).mkv` beside `Talk.en.srt`
  is worse than no subtitle at all: every media server reads that subtitle as
  belonging to the other video.

📌 And the comparison is case-**insensitive**, because a library on exFAT or on
a macOS share treats `Talk.mkv` and `talk.mkv` as one file. A check that says
the name is free there is a check that hands over an overwrite.


## The live queue stopped showing new work past 200 jobs, and said nothing (2026-08-27)

Found while giving `GET /api/jobs` a server-side sort. The SSE watcher built
every frame from:

```ts
const jobs = await queue.list({ limit });   // limit = 200
```

`queue.list` with no `sort` is the **queue's** order — priority rank, then
*oldest first* — because that is the order `claimNext` works in. So on a server
with more than two hundred jobs the live snapshot was the two hundred **oldest**
rows, all of them long finished, and a download started today was not in it at
all. The Queue screen simply stopped showing new work.

📌 It had been true for as long as the watcher existed and nobody could see it,
because it only appears past the two-hundredth job and the screen has no way to
say "there are rows I am not showing you". The reported symptom would have been
"the queue looks stuck", three layers from the cause.

⚠️ The obvious one-query fix is wrong too. Ordering by status rank puts `done`
(6) above `failed` (7), so a long history of successes pushes every failed job
off the end — the rows somebody actually needs. The snapshot is now two queries:
everything unfinished, then the newest terminal rows to fill the page.


## `bun test` runs a test that does not compile — and it opened the real database (2026-08-27)

`openDb` takes an options object. A new test wrote:

```ts
db = openDb(join(dir, "casatube.db"));   // a type error
```

`tsc` says so plainly — `Type 'string' has no properties in common with type
'OpenDbOptions'` — but **`bun test` transpiles rather than type-checks**, so the
suite ran happily. The string arrived as `options`, `options.path` was
`undefined`, and the fallback opened `appDbPath()`: the development database in
`./data`. The retention sweep under test then deleted rows out of it, and the
test's own assertions were what noticed, because the counts did not match what
the test had seeded.

📌 Two lessons, and the second is the useful one. A green `bun test` is not
evidence that the file compiles — run `bun run typecheck` before believing a new
test file. And a default that reaches for production is a loaded gun: `openDb`
now throws on a non-object argument, so the same typo is a stack trace rather
than a write to the real table.

⚠️ It is worth noticing *why* the mistake survived to run at all. Everything in
this repo already opens the database as `openDb({ path })`; the wrong call was
written from memory of a different signature and never read back against a
neighbouring test.


## `min-w-0` + `flex-1` + `truncate` still lets one long path widen the whole grid (2026-08-27)

The Settings screen overflowed sideways on an iPad: `innerWidth` 820,
`document.documentElement.scrollWidth` **1095**. Every card measured 785 px
wide, and no card was asking for it — the *grid column* was.

The driver was one row in the storage card:

```tsx
<div className="flex flex-wrap items-baseline justify-between gap-2">
  <span>Library</span>
  <span className="min-w-0 flex-1 truncate font-mono">{longPath}</span>
</div>
```

A filesystem path is a single unbreakable word. Inside a **wrapping** flex row,
Chrome gives such an item a min-content contribution of its whole width —
`min-width: 0` and `flex: 1 1 0%` are both applied (verified in the computed
style) and neither stops it. Measured with `style.width = "min-content"`:

| | min-content |
|---|---|
| the row with `truncate` | **785 px** |
| the same row with `break-all` | ~40 px |
| the card's other rows | 65–108 px |

📌 `truncate` is `overflow:hidden` + `white-space:nowrap`, and *nowrap is the
problem*: an item that cannot break cannot shrink, and a flex item that cannot
shrink sets the min-content width of every ancestor, up to and including a
single-column grid track. The fix is to let the text break (`break-all`), which
also reads better — the whole path is visible instead of cut off.

⚠️ Only reproducible with a genuinely long value: the same screen with
`DATA_DIR=/data` looks perfect. It was found with a scratch directory whose path
is 90 characters, and the check that proves it is one number —
`document.documentElement.scrollWidth` against `innerWidth`, on the width you
actually care about.

## An `interface` does not satisfy `Record<string, unknown>`, so `useSetSearch<LibrarySearch>` does not compile (2026-08-27)

Adopting the scroll fix on the Library screen looked like one line:

```ts
const setSearch = useSetSearch<LibrarySearch>();
//                             ^ Type 'LibrarySearch' does not satisfy the
//                               constraint 'Record<string, unknown>'.
```

`useSetSearch<S extends Record<string, unknown>>` accepts the Dashboard's
`useSetSearch<{ range: StatsRange }>()` and rejects the Library's, and the two
look identical. **A type alias for an object literal gets an implicit index
signature; a declared `interface` does not** — the compiler assumes an interface
may be augmented later with a member of another type, so it refuses to promise
anything about unknown keys.

Three fixes, and only two are honest: widen the call site
(`useSetSearch<LibrarySearch & Record<string, unknown>>()`, which is what
`screens/Library.tsx` does), or turn the declaration in `search-params.ts` into
a `type`. Loosening the hook's own constraint is the third, and it would remove
the check from every screen to spare one.

📌 Worth knowing because **every remaining screen with the scroll bug is an
`interface` in `search-params.ts`** — Sources, Storage and Settings will each
meet this the moment they are fixed, and the error names the constraint rather
than the cause.

## `matches: []` claims **every** URL, not none (2026-08-27)

`manifestMatches` reads an empty `matches` as *no restriction*:

```ts
if (patterns === undefined || patterns.length === 0) return true;
```

That is deliberate — the Jellyfin refresh and the webhook are plugins about the
*result*, not the source, and both ship `matches: []` — and it is the exact
opposite of what the array looks like it says. Two of the three built-ins are
therefore returned by `GET /api/plugins/applicable?url=` for **any** URL you
paste.

📌 It matters the moment a screen puts the answer into words. "2 plugins claim
this URL" is wrong for a plugin that claims every URL, and the wrongness is
invisible from the outside: the list is correct, the sentence is not. The
download window says *"Applies to every download"* for an empty `matches` and
*"Claims bit.ly, t.co, …"* only when there is a list.

⚠️ Read the other way round, this is also the trap for anyone writing a plugin:
omitting `matches` because "it doesn't match anything yet" ships a plugin that
runs on everything.

## Plugins loaded, were listed, were configurable — and never ran (2026-08-27)

Found while building the per-download override PLAN §5 asks for. The override
needed somewhere to be applied, and following the dispatch path led nowhere:
**nothing in the pipeline ever called `runtime.run`.** Not one of the six hook
points. Plugins were discovered, validated, activated, shown on the Settings
screen with their capabilities and hooks, enabled, disabled, configured — and
the worker was never handed the runtime at all.

Proven rather than argued, because a search proves only that a search found
nothing: a plugin declaring all six points and logging at each was installed on
a running server, a job was queued, and it printed nothing.

📌 The reason it survived is the reason it is written here. Every visible
surface said it worked — a plugin list with states, an "applies to this
download" panel, log lines from `setup()` — and `setup()` running is exactly
what makes a plugin *look* alive. The only observable difference between "the
hook fired and did nothing visible" and "the hook never fired" is a plugin
written to say so.

⚠️ And a design constraint fell out of it that is easy to get wrong in the
other direction: a per-download override can only turn a plugin **off**. A
plugin that is off server-wide is never activated, so it registers no hooks and
there is nothing to dispatch to — offering "on for this one download" would be
a fourth control that moves and changes nothing.

## A *value* imported from `core/` into `src/web` breaks the bundle, and `tsc` says nothing (2026-08-27)

The credentials screen needed the four credential types to draw its type
picker, and `core/credentials.ts` already exports them:

```ts
import { CREDENTIAL_TYPES, type CredentialType } from "../../../core/credentials";
```

`bunx tsc --noEmit` is clean. The tests pass. The **browser bundle stops
building**:

```
error: Browser build cannot import Bun builtin: "bun". When bundling for Bun, set target to 'bun'
    at src/core/credentials.ts:42:30      ← import { randomUUIDv7 } from "bun"
```

`verbatimModuleSyntax` erases `import type`, so every other reference this
folder makes to a `core` type costs nothing at runtime. A *value* import does
not get erased: it drags the whole module in, and with it `bun:sqlite`, drizzle
and the `bun` builtin.

⚠️ **How it presents is the trap.** `Bun.build` fails, `api/web.ts` catches it
and serves the error page, and the server log says exactly two words —
`client bundle failed: Bundle failed`. The API keeps working, so `curl` is
perfectly happy while the app is a blank error page. The real message only
appears if you run `Bun.build` yourself.

📌 The fix is a local copy of the list, typed against the core type so it
cannot drift:

```ts
export const CREDENTIAL_TYPE_ORDER: CredentialType[] = ["cookies", "password", "apiKey", "custom"];
export const TYPE_LABEL: Record<CredentialType, string> = { ... };  // exhaustive by construction
```

The general shape, and it is the same one as the import cycle further down this
file: **`tsc` type-checks a graph the bundler does not have to be able to
build.** Anything under `src/web` may import *types* from `src/core` freely and
must not import a value from it.

## An unmounted NFS mountpoint `stat`s perfectly, and every file under it is `ENOENT` (2026-08-27)

The obvious way to answer *"is this download still on disk?"* is `stat`, and the
obvious reading of `ENOENT` is "it is gone". Both are wrong in the case this
project actually runs in.

A network mount is a **directory that something is mounted onto**. When the
mount fails — the NAS is asleep, the credentials expired, the unit did not come
up after a reboot — the mountpoint directory is still there, empty, on the local
disk. So:

| Check | Healthy | **Mount failed** | Library genuinely deleted |
|---|---|---|---|
| `stat(root)` | ok, directory | **ok, directory** | ENOENT |
| `stat(root/Videos/Talk.mkv)` | ok | **ENOENT** | ENOENT |

The middle column is indistinguishable from a file someone deleted, one path at
a time. A UI built on that arithmetic tells a person that two hundred downloads
have vanished, at the moment their NAS is merely asleep — which is the most
alarming thing this application could say, and it would be false.

🔴 So `core/library.ts`'s `presence()` has **three gates**, and the second one is
the whole point:

1. `stat` the **root**. It does not answer → everything is `mount-unavailable`.
   (Catches `LIBRARY_DIR` pointing nowhere, and permissions removed.)
2. `readdir` the root. It is **completely empty** while we are being asked about
   files in it → everything is `library-empty`. This is the column above.
3. Only then, per path, on its own errno — and only `ENOENT` and `ENOTDIR` are
   allowed to mean absence. `EACCES` and a timeout are `unknown`.

⚠️ Gate 2 misreads a library someone really did empty as `unknown` rather than
`missing`. That is deliberate and it is the cheap direction to be wrong in: an
unnecessary "cannot say" costs a re-check, and an unwarranted "your file is
gone" costs somebody their afternoon. There is no signal that separates the two
— `st_dev` against the parent only says "this is not a mount point", which a
library legitimately may not be.

📌 The general shape, and it is the sixth time in this file: **an instrument that
answers cheerfully about the wrong subject.** `stat` was asked "is there a file
here" and answered correctly every time; the question was "can I see the library
at all", and nothing in a per-path `stat` can reach it.

## `useMemo` over `query.data ?? []` never memoises anything (2026-08-27)

```tsx
const all = jobs.data?.jobs ?? [];
const ids = useMemo(() => all.filter(...).map(...), [all]);   // ← runs every render
```

`?? []` builds a **new array** on every render where the query has no data, so
the dependency changes every time and the memo is pure overhead — plus a
dependency list that reads as a promise it does not keep. React Doctor's
`exhaustive-deps` names it exactly: *"`all` is rebuilt every render, so `useMemo`
runs every time."*

📌 Worth knowing which half to fix. Here the memo existed to keep a React Query
*key* stable — and the key is a **string** built from the ids, which React Query
hashes, so the array's identity was never what mattered. The fix was to delete
the memo and do the work in one pass, not to stabilise the array.

## A query string does not bust Bun's module cache, so "reload the plugin" reloaded nothing (2026-08-27)

`plugin-runtime.ts` reloaded by importing `file:///…/plugin.ts?g=<generation>`,
with a comment explaining that the cache-buster was what made an edited plugin
take effect. It is not. **Bun keys its module registry on the resolved path and
drops the query and the hash from a `file:` URL**, so every reload after the
first handed back the first evaluation.

Measured against Bun 1.4, editing the file between each import:

| | |
|---|---|
| `import(href)` | `first` |
| `import(href + "?g=2")` | `first` |
| `import(href + "?t=" + Date.now())` | `first` |
| `import(href + "#" + Date.now())` | `first` |
| `import(<a different filename>)` | **`second`** |

Nothing errored. The old plugin simply kept running, with the new source sitting
on disk — and the *manifest* shown in the UI was the old one too, so there was
not even a disagreement between two layers to notice.

The fix is a throwaway copy: each file is copied to a hidden sibling
(`.casatube-reload-<generation>-<name>.ts`), imported, and deleted. A **sibling**
rather than a temp directory, because `import.meta.dir` and any relative path
inside the plugin have to resolve the way they would from the real file; and
hidden because that is exactly what the loader skips and what the editor refuses
to write. The error message is rewritten back to the real filename, so a syntax
error names the file the user typed.

⚠️ It is done on **every** load, not only reloads. Two runtimes over the same
directory in one process — which is what a test suite is — would otherwise have
a first load that behaved differently from every load after it.

📌 It was invisible for as long as it existed, because nobody edits a plugin
without also restarting the process. **An editor is what turned a dormant bug
into the main feature not working.** The regression test is in
`plugin-runtime.test.ts` → *"reloading actually reloads"*, and it asserts both
halves: the manifest moved, **and** the hook returns the new value. Asserting
only the manifest would pass with `setup` never re-run.

## A React Query mutation in a dependency array is an infinite render loop (2026-08-27)

```tsx
useEffect(() => {
  setPatch({});
  save.reset();
}, [open, name, save]);        // ← `save` is new on every render
```

`useMutation` returns a **new result object every render**. Listing it as a
dependency makes the effect run every render; the effect calls `setState`, which
renders; which runs the effect. React ends it with *Minified React error #185*
("Maximum update depth exceeded") and the whole screen becomes an error
boundary — in this case the entire Settings page, from one dialog nobody had
opened yet.

`tsc` is perfectly happy, and the lint rule that exists for the opposite mistake
(*missing* dependencies) actively pushes you into this one.

📌 The fix is a ref: `resetSave.current = save.reset` on every render, and
`[open, name]` as the dependency list. The general shape — and it is the third
time this project has met it — is **a value whose identity changes more often
than its meaning**. Query results, mutation results and inline object literals
all qualify.

⚠️ Found by clicking, not by reading or by a test. It needed a browser, a real
render, and the specific click that mounted the dialog.

## A plugin's own log is API output, and no server-side rule can redact it (2026-08-27)

`GET /api/plugins` returns each plugin's recent `log` lines, and a setting marked
`secret` is stripped from every value the API reports. A test asserting "the
token never appears in any response" still failed — because the *test plugin*
did `log("TOKEN=" + config.TOKEN)`, and the runtime dutifully stored and served
what it was given.

That is not a leak in the redaction rule; it is the boundary of one. The server
can refuse to echo a value it was asked to keep, and it cannot know that a string
a plugin chose to print is that same value.

📌 So `plugins/README.md` says it plainly — do not log a value you declared
`secret` — and the test plugin logs `TOKEN_LEN=7` instead. Worth noticing that
the honest version of the test is also the one that *proves the value arrived*:
asserting only that "hunter2" is absent would pass just as well if the setting
had never been stored at all.

## The scroll jumps to the top because the *router* scrolls it, not React (2026-08-27)

Scroll to the bottom of the queue, click a row, and the page snaps back to the
top. The natural suspects are all wrong: the list is not remounted, the rows are
not re-keyed, and focus does not move anywhere that would scroll. Measured on
the running app — `tbody` and the first `<tr>` are **the same DOM nodes** before
and after the click.

**TanStack Router scrolls the window to `(0, 0)` after every navigation unless
told not to**, and a search-param change *is* a navigation. `router-core`'s
`setupScrollRestoration` runs unconditionally at router construction; even with
`scrollRestoration` unset it still registers an `onRendered` subscriber whose
first act is:

```js
const shouldResetScroll = scroll.next;   // set from `resetScroll ?? true`
…
if (!hash) { if (!windowRestored) scrollTo({ top: 0, left: 0, behavior }); }
```

So selecting a job, moving a filter and *typing a character into the search box*
were each one full "scroll to top".

The fix is `resetScroll: false` on every `navigate` that only rewrites search
params. Both job screens funnel their navigations through a single `setSearch`
helper so it cannot be forgotten on the one call that would bring the jump back.

Measured, same page, same build:

| | before click | after click |
|---|---|---|
| Queue at 1440 px, `resetScroll: false` | 2587 | **2587** |
| Queue at 820 px (sheet opens over it) | 2517 | **2517** |
| Downloads at 1600 px (inspector docks) | 1203 | **1203** |
| Dashboard's range `Select` — a screen not yet fixed | 448 | **0** |

📌 The last row is the point: the bug is **per-`navigate`, not per-screen**, and
every other screen that writes a search param still has it. Library, Sources,
Storage, Settings and the Dashboard are each one `resetScroll: false` away.
Setting it once on the router would be tempting and is a different decision —
a real route change *should* start at the top.

## `#HttpOnly_` is a cookie, not a comment — and a jar of spaces is not a jar (2026-08-27)

Two traps in the Netscape `cookies.txt` format, both of which produce a file
that looks fine and authenticates nothing.

**`#HttpOnly_.youtube.com` starts with `#`.** Chrome and Firefox both write that
prefix, and a parser that skips every line beginning with `#` silently drops
**exactly the cookies that authenticate** — `HSID`, `SSID` and the rest are
httpOnly by design. The file parses, the count comes out plausible, and the
session is not in it.

**Tabs, and only tabs.** The seven fields are tab-separated, and copying a jar
through a terminal, a chat window or a text editor turns those tabs into runs of
spaces. yt-dlp then reads one field per line and behaves as if signed out. The
whole file arrives as a single field, so the useful error is not "7 fields
expected, got 1" — it is *"this was separated by spaces, export it again"*, which
is what `parseNetscapeCookies` says.

📌 The general shape, and it is why validation happens at the moment of pasting:
a credential that is wrong fails **twenty minutes into an 800 MB download**,
three layers away from the paste that caused it. An immediate rejection costs a
second and names the line.

## A cookie's domain covers its subdomains, so "does the scope cover the domain" is backwards (2026-08-27)

The check that a stored jar actually belongs to the site it is filed under looks
like one line: for scope `www.youtube.com`, does any cookie domain match it?

Written as `scopeMatchesHost(scope, domain)` it **rejects the correct answer**.
A browser exports the YouTube session as domain `.youtube.com` — a *domain
cookie*, which by the cookie spec applies to `www.youtube.com` and
`music.youtube.com` too. Asking "does the scope cover the domain" says no, and
the test button fails on precisely the jar that would have worked.

The relation has to be checked **both ways**: a domain covers a scope when it is
the same host, when the scope sits under it (the domain-cookie case), or when it
sits under the scope. What is left failing is the case worth failing — a jar
exported from an entirely different site.

⚠️ Caught by curl against the running server, not by a unit test: the unit test
used `youtube.com` for both and passed either way.

## WAL means a fresh write is not in the `.db` file yet (2026-08-27)

Checking "is the secret encrypted at rest" by grepping `casatube.db` for the
plaintext returned **0 hits — and would have returned 0 hits either way**. The
connection runs `PRAGMA journal_mode = WAL` (`core/db.ts`), so a row written a
second ago lives in `casatube.db-wal` until a checkpoint moves it.

The give-away was that `aes-256-gcm`, which the row definitely contains, was not
in the `.db` file either. Grepping the WAL as well found both marks and neither
secret.

📌 Third entry in this file about an instrument that lies, and the fix is the
same one every time: **before concluding something is absent, prove the check
could have seen it.** Here that was one positive control — the same grep against
the file the cookie was pasted from.

## Two documented environment variables are read by nothing (2026-08-27)

`MAX_CONCURRENT_DOWNLOADS` and `LOG_LEVEL` are set in **three** places —
`PLAN.md` §12, `docker-compose.yml` and the Dockerfile's `ENV` block — and
`grep -r` over `src/` finds neither. Everything else in that table is genuinely
read by `api/config.ts`; these two are not.

They are not stale leftovers, they are **unimplemented**:

- The worker claims one job at a time (`worker.ts`'s loop is `claimNext` then
  `await this.run(...)`), so there is no concurrency to limit. PLAN §17 says the
  cap belongs to the download stage, and that stage does not exist as a
  schedulable unit yet.
- There is no log-level switch anywhere; everything goes through `console.log`.

📌 Written down because the natural thing to do when building an editable
settings screen is to offer every variable the documentation names — which would
have produced two controls that change a number and no behaviour. Anything
`core/app-settings.ts` lists, the code reads; these two are deliberately absent
and this is the note saying the absence is on purpose.

⚠️ The general shape, and it is the same one the worklog keeps recording:
**configuration is an instrument, and an instrument can be disconnected.**
Before putting a variable on a screen, check that something reads it — the
Dockerfile setting it proves nothing about whether the app looks.

## Going fullscreen resizes the viewport, so a `matchMedia` layout switch destroys the player (2026-08-27)

Fullscreen made the video enter and immediately leave again, on desktop and at
tablet width. It was not the player, not the SSE refresh and not Radix.

**Entering fullscreen resizes the layout viewport to the screen.** A 1440 px
window on a 1920 px monitor becomes a 1920 px viewport for as long as the video
is fullscreen — measured with no emulation at all: `innerWidth` 945 → 1920 on
the way in, 1920 → 945 on the way out. That crosses `useDockedPanels`'
`(min-width: 1536px)`, and docked and undocked are **different components** (a
`Sheet` and an `<aside>`, deliberately, so a hidden overlay cannot eat clicks).
So React unmounts one and mounts the other — and **removing the fullscreen
element from the document exits fullscreen.** The timeline, from the real MKV:

```
2109  <video> added          ← the docked aside mounts (viewport is now 1920)
2117  fullscreenchange IN    innerWidth=1920
2402  <video> removed        ← the sheet, holding the fullscreened player, unmounts
2418  fullscreenchange OUT   ← because its element is gone
2488  removed / added        ← viewport back to 945, panel swaps back
```

The fix is to freeze the query while `document.fullscreenElement` is set. The
event order makes that sound: on the way **in** Chrome fires `resize` and the
`matchMedia` change with `fullscreenElement` **already set**; on the way **out**
it fires them with it **already null**. Verified, not assumed — a guard that
ran before the element was registered would do nothing.

⚠️ It is invisible to headless testing with a CDP viewport override:
`Emulation.setDeviceMetricsOverride` pins `innerWidth`, so fullscreen changes
nothing and the bug does not reproduce. Launching with `--screen-info={1920x1080}`
and a smaller window is what makes it appear.

📌 The general shape: **a `matchMedia` read is a fact about the window, and
fullscreen changes that fact.** Any layout decision that swaps component
identity — not just this one — is a decision that can delete the element the
browser is currently showing full-screen.

## A control bar that does not wrap loses its last buttons in silence (2026-08-27)

The eight player controls need about 360 px. The docked inspector was giving the
bar 284, and a `flex` row with no `flex-wrap` neither shrinks nor scrolls: it
lays its children out past its own edge, where the player's `overflow-hidden`
clips them. Playback speed, PiP and **fullscreen** were painted nowhere and
could not be clicked — so the widest layout in the app was the one with no
fullscreen button, which is half of why "fullscreen does not work".

Nothing errors and nothing looks broken. The bar just ends after the clock, and
the only way to see it is to compare the row's `scrollWidth` against its
`getBoundingClientRect().width`, or a child's `right` against its parent's.

📌 Widening the panel is the fix for *today's* eight controls. `flex-wrap` plus
two groups is the fix for a ninth one, a `1:23:45` duration, or an expanded
volume slider — any of which spends the slack again.

## `cn` is `twMerge`, so a later class wins — but only against the *same* variant (2026-08-27)

`SheetContent` hard-codes `sm:max-w-sm`; the caller passes `sm:max-w-lg` and
gets 32rem, because `cn` runs `twMerge` and same-variant conflicts resolve
last-wins in the string.

⚠️ **This is not a contradiction of the `sm:max-w-lg` beats `max-w-3xl` entry
below.** There the two classes are *different* variants, twMerge does not see a
conflict, leaves both standing, and the CSS cascade decides — which is why the
unprefixed one loses everywhere above `sm`. Same helper, opposite outcome: the
question is always whether the two classes carry the same variant prefix.


## `FFMPEG_BIN` does not reach yt-dlp, and the failure is a `.webp` (2026-08-27)

`--convert-thumbnails jpg` is an ffmpeg post-processor, and yt-dlp looks for
ffmpeg **on `PATH`** — nothing forwards our `FFMPEG_BIN` to it as
`--ffmpeg-location`. On a box where ffmpeg is not on `PATH`, the run says:

```
postprocess ThumbnailsConvertor: started
WARNING: You have requested merging of multiple formats but ffmpeg is not installed…
ERROR: Preprocessing: ffmpeg not found. Please install or provide the path using --ffmpeg-location
```

The merge fails the job loudly, so the missing ffmpeg does get noticed — but the
thumbnail half fails *quietly*: the original `Name.webp` simply stays where the
JPEG was meant to be. WebP is not read by several media servers, so the symptom
is "Jellyfin shows no poster", three layers away from the cause.

📌 So the thumbnail collector accepts `.jpg`, `.jpeg`, `.png` **and** `.webp`
rather than insisting on the conversion having happened. The image has
ffmpeg on `PATH`, so production converts; a development machine may not, and
losing the picture over the format would be the wrong trade.

✅ **Fixed (2026-08-27).** `FFMPEG_BIN` now reaches yt-dlp as
`--ffmpeg-location`, so one variable means one thing. The fix is not a
pass-through, and the reason is a second trap: yt-dlp answers a location that
does not exist with a *warning* and continues **without ffmpeg**, so forwarding
an unresolvable value is worse than forwarding nothing — a typo would disable
the merge that `PATH` would have served. `resolveFfmpegLocation` therefore looks
a bare name up on `PATH` (which is exactly what the flag does not consult),
requires a path to exist, and returns `undefined` otherwise.

📌 And a third, found while writing it: given a **file**, yt-dlp keeps that file
as ffmpeg and derives every other program as `dirname(location)/<program>`. An
ffmpeg with no ffprobe beside it therefore takes ffprobe *away* — yt-dlp looks
at a path that does not exist instead of falling back to `PATH`. The boot log
says so rather than leaving it to be discovered.

## An import cycle is a runtime error that `tsc` is perfectly happy with (2026-08-27)

`core/thumbnails.ts` imports the deadline helper and the path guard from
`core/library.ts`; `core/library.ts` imported the list of image extensions back
from `core/thumbnails.ts`. Types are erased, so the compiler saw nothing wrong —
and the **value** import blew up at module initialisation:

```
ReferenceError: Cannot access 'THUMBNAIL_EXTENSION_SET' before initialization
```

It surfaced as every test in an unrelated file failing before the first
`expect`, which reads like a broken test runner rather than a bad import.

📌 The rule that fixes it: a shared constant belongs in the module with **no
dependencies of its own** — here `core/library.ts`, which is imported by the
other and imports nothing back. `bunx tsc --noEmit` cannot be the check for
this; only running it is.

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

## A flaky `probe` that could not be reproduced (2026-08-27)

Reported: in a long-running server the first three `/api/library/item?probe=1`
calls succeeded and the fourth returned `ProbeFailed`, repeatably-ish, while the
same spawn loop standalone succeeded every time.

**Not reproduced.** Inside the container, against the real `ffprobe` and the real
library, `probe()` returned 15/15 sequentially and 2, 4, 8 and 16 in parallel
with no failures.

The likely explanation is environmental: the report came from a session running
on the **host**, which has no `ffprobe` — the same report notes putting one on
the `PATH` to make Duration and Bitrate render. So the failures were probably
that improvised binary, not our spawn path.

📌 Written down rather than closed silently, because "could not reproduce" is a
result and the next person deserves to know what was already tried. If it comes
back **inside the container**, the spawn path in `core/library.ts` is where to
look, and the two experiments above are the ones not to repeat.

## Killing your own subprocess looks exactly like that subprocess failing (2026-08-27)

The transcode queue kills its ffmpeg on shutdown, which is correct — an encoder
left running by a restart is the whole machine burning on a file nobody asked
for. What it then did with the exit code was not: `proc.exited` returns **255**,
`code !== 0` is the failure branch, and a real 73-minute encode interrupted by a
`SIGTERM` came back as

```
attempt 1/2 failed: ffmpeg exited with code 255
```

Two deploys would have retired the job for good, with an error blaming the file
for something we did to it. Found by killing a real encode, not by a test — the
unit test that catches it now was written *after* the run that showed it.

📌 The general shape: **an exit code says how a process ended, never why.** Any
code that kills a child has to record its own intent *before* the kill and read
it back after, or it will misread its own decision as the child's failure. Ours
sets `stopping` (a shutdown: leave the row alone, `recoverOnStart` requeues it)
alongside the `cancelled` it already had (a person's decision: mark it, remove
the partial output) — two flags, because they mean two different things and only
one of them is worth telling the user about.

## A 438 MB video that hung on "loading": 3.74 GB on the wire, and size was not the variable (2026-08-27)

`Videos/My Secret Agent Husband EP.mp4` — 73 min, 438 MB, h264 High + AAC-LC,
`moov` at 0% — sat on a spinner while short videos in the same library played
instantly. Everything measurable about the file, the route and the container was
correct: verdict `direct`, ranges answered in all four forms, first byte in 1 ms,
probe and thumbnail in milliseconds.

**The file is a fragmented MP4.** Not `moov` + one `mdat`, but `mvex` in the
movie header followed by **1475 `styp`/`sidx`/`moof`/`mdat` fragments**, with no
global index and `mvhd.duration = 0`. Counted, not guessed:

```
My Secret Agent Husband EP.mp4  {ftyp:1, moov:1, styp:1475, sidx:2950, moof:1475, mdat:1475}
O+ (O Positive)…mp4             {ftyp:1, moov:1, free:1, mdat:1}     ← plays fine
Me at the zoo.mp4               {ftyp:1, moov:1, free:1, mdat:1}     ← plays fine
```

A browser handed one of these learns the duration — and where any given second
is — only by **reading every `moof` in the file**. Chrome does that with a burst
of open-ended `Range: bytes=N-` requests marching from 0 to EOF, and abandons
each after a few kilobytes. From the network panel, `preload="metadata"`, before
a single frame:

| | Requests | Bytes on the wire |
|---|---|---|
| The fragmented 437 MB file | **468** | **3.74 GB** (8.7× the file) |
| Its own bytes remuxed to a plain MP4, 439 MB | **1** | **11.8 MB** |
| The 59 MB plain MP4 in the same library | 1 | 11.9 MB |

🔴 **So size is not the variable — container shape is.** The middle row is the
experiment that settles it: `ffmpeg -c copy -movflags +faststart` on the same
73 minutes, the same codecs, the same 439 MB, and the browser reads 12 MB and
stops. A size threshold on `direct` would have punished every large file and
still missed a fragmented small one.

**Why 3.74 GB and not 468 × a few KB**: the route answered `bytes=N-` literally
— "everything from N to the end", hundreds of megabytes — and in the deployed
container an abandoned request had already pushed **6 to 9 MB** into the socket
before the reset landed (measured three times). 468 × 8 MB is the 3.74 GB; the
arithmetic closes.

**Two fixes, and they are independent.**

1. `decidePlayback` now looks at the **shape of the file**, not only its
   extension and codecs: an MP4 whose `moov` declares `mvex` is served as HLS.
   `readMp4Layout` reads 256 KB of the head and walks the top-level boxes, once
   per (size, mtime), behind the same cache as the probe. After the change the
   same file starts in **5.9 MB** — an index and five segments — plays, and seeks
   to 40 minutes.
2. An open-ended range is answered with **at most 4 MB** for inline playback
   (RFC 9110 §14.4 allows a shorter 206). ⚠️ **Not for `?download=1`**: a
   download manager resuming with `bytes=N-` writes what it is given and calls
   the file finished, so a cap there is a silently truncated save.

📌 The general shape, and it is the fourth time in this file: **`ffprobe`
answered every question anyone asked and none of them was the question.** Codec,
profile, duration, bitrate and `moov` position were all correct and all
irrelevant. What mattered — "does the front of this file say where anything is"
— is not a field in any probe output, and had to be read out of the boxes.

⚠️ For the next person: `ffprobe` gives no hint. `{styp, sidx, moof} > 0` in a
top-level box count does, and a twelve-line box walk is all it takes.

---

### The table from the first day, kept because it is still true

Every one of these was measured against the running container before the cause
was found, and every one of them came back clean. They are the checks **not** to
repeat on the next file that will not play — none of them can see a fragmented
container.

| Suspicion | Result |
|---|---|
| Goes through HLS and stalls | No — verdict is `direct`; HLS is never involved |
| `moov` atom at the end of the file | No — it is the second box, at 0% |
| Exotic codec or profile | No — h264 High, `yuv420p`, level 30, AAC-LC stereo |
| Range requests broken | No — `bytes=0-1023`, a tail range, `bytes=0-` and no header all correct |
| Server slow to answer | No — first byte in **1 ms** |
| Thumbnail or probe blocking the panel | No — 2 ms and 185 ms |

That list is what made "the fault is in the client or the transport" the right
next step, and a real browser with the network panel open is what answered it.

⚠️ The design question the first day raised — "should `direct` look at **size**?"
— was the plausible-and-wrong one. It was tested rather than adopted: see the
remuxed 439 MB row above.


## A documented limit that was never implemented (2026-08-27)

`MAX_CONCURRENT_DOWNLOADS` appeared in `PLAN.md`, in `docker-compose.yml` and in
the `Dockerfile`. It was argued over at length — 1 or 3, my connection
arithmetic against metube's seven-year track record — and the answer was written
down as 3.

**Nothing in `src/` ever read it.** The worker awaited each job in turn, so the
real limit was always **1**.

Found by the settings work, which needed the list of settings that actually
exist and noticed two that were configuration in name only (`LOG_LEVEL` is the
other; there is no log-level switch).

📌 The lesson is not "check your config wiring". It is that **a number in a
document, a compose file and a Dockerfile still looked like a feature from every
angle** — three places agreeing with each other and none of them agreeing with
the code. Documentation is not evidence of behaviour, however much of it there
is.

## Two ports, two servers, one number (2026-08-27)

Bun binds with `SO_REUSEPORT`, so **starting a second server on a port already
in use succeeds** and the kernel splits requests between them. A leftover
process kept serving a stale bundle alongside the new one, half the requests got
old code, and an agent "fixed" a bug that was already fixed.

Check with `ss -lptn`; the tell is **two LISTEN rows for one port**, and curling
twice and comparing the asset hash.

⚠️ **It bit again on 2026-08-27, and it invalidated a measurement.** The way in
was a shell line whose *later* half failed:

```bash
PORT=8702 … nohup bun src/server.ts > log 2>&1 & echo "PID=$!" > /server.pid
#                                                                ↑ permission denied
```

The server started; the pid was never written. Killing the pid recorded by the
*next* attempt therefore left the first one running, and the kernel round-robined
between a server pointed at the real library and one pointed at a path that does
not exist — so "the mount is down, everything must read unknown" came back
`present` for half the requests, repeatably enough to look like a bug in the code
under test.

📌 The general shape again: a check that answers, but not about the thing you
think it is about. And the specific lesson: **`ss -lptn | grep <port>` before
trusting any measurement**, not only when something looks wrong — a second server
makes results *plausible*, not obviously broken.

## Radix restores focus by scrolling to it (2026-08-27)

A `Select` on a long page yanked the reader back to the top on close. It looked
like the TanStack Router scroll reset — and routing it through `useSetSearch`
**did not fix it**.

Instrumenting showed `scrollTop` going 350 → 0 with `scrollHeight` unchanged and
**neither `window.scrollTo` nor the `scrollTop` setter ever called**. Radix
restores focus to the trigger with a bare `focus()`, and focusing an off-screen
element scrolls it into view — the browser did it, not our code.

```ts
onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
```

Fixed once in `components/ui/select.tsx` rather than per screen: the version of
this bug that survives is always the one somebody forgot in their own corner —
which is exactly how the router half of it lived on six screens.

⚠️ **Two independent causes wearing the same symptom.** The first fix was real
and the bug stayed, which is the moment to suspect a second cause rather than to
doubt the first fix.


## `curl /api/health` does not tell you the app works (2026-08-27)

Importing a **value** from a core module into browser code typechecks fine and
**breaks `Bun.build`**: it drags `bun:sqlite` and drizzle into a browser target.
The server prints one line — `client bundle failed` — and **carries on serving
the API**.

So every health check passes, every route answers 200, and the page is blank.

`scripts/smoke.sh` closes it: it fetches the page, extracts the `/assets/*.js`
it references, and fetches that too. A missing or tiny script fails the check.

⚠️ **Verified by pointing it at a server that serves HTML without our bundle** —
it failed, as it should. A check nobody has seen fail is not yet a check.

📌 Types are not the boundary here. `import type` is erased; a value import is
not, and only the bundler finds out.
