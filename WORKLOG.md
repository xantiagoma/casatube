# Worklog

Where the work is, so it can be picked up by anyone — including a future
session with none of this context. Newest first.

---

## 2026-08-26 — Foundation laid, phase 1 starting

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
