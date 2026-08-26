/**
 * `GET /api/events` — the live queue, pushed.
 *
 * ## How the SSE is done, and why this way
 *
 * Elysia 1.4 does SSE natively: an **async generator handler** that yields
 * `sse(...)` payloads. Verified against the installed 1.4.29 rather than
 * assumed — the response carries `content-type: text/event-stream` and
 * `cache-control: no-cache` on its own, and when the client disconnects the
 * generator's `finally` runs and `request.signal` is aborted. That last part is
 * what decides it: cleanup is structural, so a closed tab cannot leak a
 * subscriber. No `Bun.serve` underneath was needed.
 *
 * The wire shape is `event:` + JSON `data:`, which `@elysiajs/eden` parses back
 * into `{ event, data }` on the client — so the browser reads this stream
 * through the same typed client as every other call, with no hand-written
 * `fetch` and no `EventSource` re-implementing the payload types.
 *
 * ## What it sends
 *
 * Whole snapshots, not deltas. The queue is tens of rows on a home server, and
 * a snapshot makes R3 fall out for free: a client that reconnects after
 * anything — a laptop lid, a restart — is correct on the first frame, with no
 * replay log and no sequence numbers to get wrong.
 */
import { Elysia, sse } from "elysia";

import type { AppContext } from "./context";

export function eventRoutes(ctx: AppContext) {
  const { watcher } = ctx;

  return new Elysia().get("/events", async function* ({ request, set }) {
    // Nothing may sit between the server and the browser holding this back:
    // a buffering proxy turns a live queue into a page that updates once.
    set.headers["x-accel-buffering"] = "no";
    set.headers["connection"] = "keep-alive";

    for await (const event of watcher.subscribe(request.signal)) {
      yield event.type === "snapshot"
        ? sse({ event: "snapshot", data: event.snapshot })
        : sse({ event: "heartbeat", data: { at: event.at } });
    }
  });
}
