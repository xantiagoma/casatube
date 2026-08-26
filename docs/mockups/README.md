# Reference designs

Target UI for CasaTube. Provided by Santi; the working name in them is
"StreamDock". Light and dark are both shown in `01-dashboard.png`.

| File | Screen | What it establishes |
|---|---|---|
| `01-dashboard.png` | Dashboard | Sidebar navigation, quick-download card, active queue, storage and analytics summaries. Light **and** dark. |
| `02-queue.png` | Queue | **Batch add** (many URLs, validate before enqueue), priority column, retry counter `n/3`, and the **Job Inspector**: Details / Tasks / Logs, with the six-stage pipeline and per-job log output. Also watch folders and smart rules. |
| `03-library.png` | Library | Collections tree, tags, favourites, filters. Detail panel with path, source, resolution, duration, captions, notes, transcript. ⚠️ Includes a **Delete** action — see PLAN.md §17. |
| `04-settings.png` | Settings | Download defaults, output formats, storage paths, cookies, integrations, ffmpeg health, scheduler, notifications, API access. ⚠️ Shows **Max Concurrent Downloads: 4** — see PLAN.md §17. |
| `05-downloads.png` | Downloads | Active / Completed / Failed / Scheduled tabs, pause-resume-cancel, ETA, per-job history timeline. |

## What these imply that the plan already accounts for

- A job is a **pipeline of six stages**, not a flat status (`02`).
- **Priority and retries** are first-class, not hidden state (`02`).
- **Per-job logs** are a product feature, not debug output (`02`).
- The **automation** section (playlists, subscriptions, scheduler, watch folders)
  is real scope, not decoration (`01`, `02`, `04`).

## What these imply that is still open

- The queue shows **`node-01` / `node-02` / `node-03`** as workers. Whether that
  means genuinely distributed workers, or just concurrency slots within one
  process, changes the architecture. The plan assumes **one process with
  configurable concurrency** until decided otherwise.
- Component libraries suggested for the build: [Dice UI](https://diceui.com)
  (installed through the shadcn CLI registry — pulls shadcn/ui, Radix and
  Tailwind) and [reui.io](https://reui.io). Its media-player component is a good
  fit for previewing before and after a download.
