/**
 * The HTTP surface, exercised end to end.
 *
 * Against a **real database file** and the real queue, because the two things
 * worth proving here are that a POST actually lands as a row (R1 — the job is
 * safe before the response reaches the browser) and that the SSE stream really
 * emits. Neither is provable against a mock, and the second is exactly the kind
 * of thing that looks fine and delivers nothing.
 *
 * The provider is a fake: probing the real one would need yt-dlp, a network and
 * YouTube's goodwill, none of which belong in a unit test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { closeDb, openDb, type Db } from "../core/db";
import { JobQueue, openJobQueue, shutdownEmbeddedQueue } from "../core/queue";
import { ProbeFailed } from "../core/errors";
import type { MediaInfo, Provider } from "../core/types";
import { createRegistry } from "../providers/registry";
import { createApp } from "../server";
import { loadConfig } from "./config";
import { createQueueWatcher } from "./watcher";
import type { ClientBundle } from "./web";

const INFO: MediaInfo = {
  externalId: "abc",
  title: "A talk about nothing",
  duration: 610,
  source: "test",
  videoFormats: [{ id: "137", height: 1080 }],
  audioTracks: [{ id: "140", language: "en", isOriginal: true }],
  subtitles: [{ id: "s-en", language: "en", automatic: false }],
};

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: "test-provider",
    supports: () => true,
    probe: async () => Result.ok(INFO),
    fetch: async () => Result.err(new ProbeFailed({ url: "", detail: "not used" })),
    ...overrides,
  };
}

/** A stub bundle: building the real React app here would cost seconds and prove nothing. */
const BUNDLE: ClientBundle = { html: "<!doctype html><title>stub</title>", assets: new Map(), builtAt: 0 };

let dir: string;
let db: Db;
let queue: JobQueue;

async function makeApp(provider: Provider = fakeProvider()) {
  db = openDb({ path: join(dir, "casatube.db") });
  queue = await openJobQueue({ db, queueDbPath: join(dir, "queue.db") });
  const watcher = createQueueWatcher(queue, { pollMs: 20, heartbeatMs: 100 });
  return createApp(
    {
      queue,
      registry: createRegistry({ fallback: provider }),
      watcher,
      config: { ...loadConfig({}), dataDir: dir, dev: false },
    },
    BUNDLE,
  );
}

type Json = Record<string, unknown>;

async function get(app: Awaited<ReturnType<typeof makeApp>>, path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`));
}

async function post(
  app: Awaited<ReturnType<typeof makeApp>>,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.handle(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-http-"));
});

afterEach(() => {
  queue?.close();
  if (db) closeDb(db);
  // Process-wide singleton keyed by dataPath — see queue.ts.
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/jobs", () => {
  test("answers with an empty list, not an error", async () => {
    const app = await makeApp();
    const response = await get(app, "/api/jobs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: unknown[]; at: string };
    expect(body.jobs).toEqual([]);
    expect(typeof body.at).toBe("string");
  });
});

describe("POST /api/jobs", () => {
  test("writes a real row and reports `queued`", async () => {
    const app = await makeApp();
    const response = await post(app, "/api/jobs", {
      url: "https://example.test/watch?v=abc",
      destination: "talks",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { outcome: string; job: Json };
    expect(body.outcome).toBe("queued");
    expect(body.job.status).toBe("queued");
    expect(body.job.destination).toBe("talks");
    expect(body.job.provider).toBe("test-provider");

    // The row, not the response: R1 is about what survives the tab closing.
    const stored = await queue.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.url).toBe("https://example.test/watch?v=abc");
  });

  test("reports `duplicate` for the same URL at the same configuration", async () => {
    const app = await makeApp();
    const first = (await (await post(app, "/api/jobs", { url: "https://example.test/a", destination: "" })).json()) as {
      job: { id: string };
    };
    await queue.update(first.job.id, { status: "done", outputFile: "/library/a.mkv" });

    const again = (await (await post(app, "/api/jobs", { url: "https://example.test/a", destination: "" })).json()) as {
      outcome: string;
      job: Json;
    };
    // 200, not 409: "already have it" is an answer, and it carries the job that
    // proves it — which an error branch would throw away.
    expect(again.outcome).toBe("duplicate");
    expect(again.job.outputFile).toBe("/library/a.mkv");

    const forced = (await (
      await post(app, "/api/jobs", { url: "https://example.test/a", destination: "", force: true })
    ).json()) as { outcome: string };
    expect(forced.outcome).toBe("queued");
  });

  test("a different resolution is a different request, not a duplicate", async () => {
    const app = await makeApp();
    const first = (await (
      await post(app, "/api/jobs", { url: "https://example.test/b", destination: "", preferences: { maxResolution: 1080 } })
    ).json()) as { job: { id: string } };
    await queue.update(first.job.id, { status: "done" });

    const other = (await (
      await post(app, "/api/jobs", { url: "https://example.test/b", destination: "", preferences: { maxResolution: 720 } })
    ).json()) as { outcome: string };
    expect(other.outcome).toBe("queued");
  });

  test("refuses a destination that escapes the library", async () => {
    const app = await makeApp();
    const response = await post(app, "/api/jobs", { url: "https://example.test/c", destination: "../etc" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Json).tag).toBe("PathOutsideRoot");
    expect(await queue.list()).toHaveLength(0);
  });

  test("refuses a URL no provider claims", async () => {
    const app = await makeApp(fakeProvider({ supports: () => false }));
    const response = await post(app, "/api/jobs", { url: "mailto:nobody", destination: "" });
    expect(response.status).toBe(422);
    expect(((await response.json()) as Json).tag).toBe("UnsupportedUrl");
  });

  test("subtitles are kept independent of audio (R7)", async () => {
    const app = await makeApp();
    const body = (await (
      await post(app, "/api/jobs", {
        url: "https://example.test/d",
        destination: "",
        preferences: { originalOnly: true, audioLanguages: [], subtitleLanguages: ["es", "en"] },
      })
    ).json()) as { job: { preferences: { audioLanguages: string[]; subtitleLanguages: string[] } } };

    expect(body.job.preferences.audioLanguages).toEqual([]);
    // Sorted and de-duplicated by `resolvePreferences`, never derived from audio.
    expect(body.job.preferences.subtitleLanguages).toEqual(["en", "es"]);
  });
});

describe("DELETE and retry", () => {
  test("cancels, then puts it back", async () => {
    const app = await makeApp();
    const created = (await (await post(app, "/api/jobs", { url: "https://example.test/e", destination: "" })).json()) as {
      job: { id: string };
    };

    const cancelled = await app.handle(
      new Request(`http://local/api/jobs/${created.job.id}`, { method: "DELETE" }),
    );
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as Json).status).toBe("cancelled");

    const retried = await post(app, `/api/jobs/${created.job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as Json).status).toBe("queued");
  });

  test("404s on a job that does not exist", async () => {
    const app = await makeApp();
    const response = await app.handle(new Request("http://local/api/jobs/nope", { method: "DELETE" }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as Json).tag).toBe("NotFound");
  });
});

describe("POST /api/probe", () => {
  test("returns the provider's media info, the choices it implies, and a suggestion", async () => {
    const app = await makeApp();
    const response = await post(app, "/api/probe", { url: "https://example.test/f" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      provider: string;
      info: MediaInfo;
      options: { resolutions: { height: number }[]; audio: { tag: string; isOriginal: boolean }[] };
      suggested: { maxResolution: number; audioLanguages: string[] };
    };
    expect(body.provider).toBe("test-provider");
    expect(body.info.title).toBe("A talk about nothing");

    // What the form draws instead of a fixed list: this video has one height,
    // one audio language, and the original is identifiable.
    expect(body.options.resolutions.map((option) => option.height)).toEqual([1080]);
    expect(body.options.audio).toEqual([expect.objectContaining({ tag: "eng", isOriginal: true })]);
    expect(body.suggested.maxResolution).toBe(1080);
    expect(body.suggested.audioLanguages).toEqual(["eng"]);
  });

  test("the suggestion honours the settings the form already has", async () => {
    const app = await makeApp();
    const body = (await (
      await post(app, "/api/probe", {
        url: "https://example.test/f",
        preferences: { maxResolution: 720, subtitleLanguages: ["en"] },
      })
    ).json()) as { suggested: { maxResolution: number; subtitleLanguages: string[] } };

    // Nothing at or below 720p in this fake, so the ceiling stands as asked.
    expect(body.suggested.maxResolution).toBe(720);
    expect(body.suggested.subtitleLanguages).toEqual(["eng"]);
  });

  test("maps a provider failure to its own status", async () => {
    const app = await makeApp(
      fakeProvider({ probe: async () => Result.err(new ProbeFailed({ url: "x", detail: "boom" })) }),
    );
    const response = await post(app, "/api/probe", { url: "https://example.test/g" });
    expect(response.status).toBe(502);
    const body = (await response.json()) as Json;
    expect(body.tag).toBe("ProbeFailed");
    expect(String(body.message)).toContain("boom");
  });
});

describe("GET /api/events", () => {
  test("opens as an event stream and sends the whole queue up front", async () => {
    const app = await makeApp();
    await post(app, "/api/jobs", { url: "https://example.test/h", destination: "" });

    const response = await get(app, "/api/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let text = "";
    // One frame is all this needs to prove: the point is that the stream emits
    // at all, and that the first thing it emits is the entire state (R3).
    while (!text.includes("\n\n")) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      // ⚠️ Elysia's SSE stream yields already-decoded strings here, not the
      // bytes the DOM types promise — handing one to `TextDecoder` throws.
      // Accept either, and take the type at its word only when it is right.
      const value: unknown = chunk.value;
      text += typeof value === "string" ? value : decoder.decode(value as Uint8Array, { stream: true });
    }
    await reader!.cancel();

    expect(text).toContain("event: snapshot");
    const payload = text.slice(text.indexOf("data: ") + 6, text.indexOf("\n\n"));
    const snapshot = JSON.parse(payload) as { jobs: { url: string }[] };
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.url).toBe("https://example.test/h");
  });
});

describe("serving the client", () => {
  test("/ is the app", async () => {
    const app = await makeApp();
    const response = await get(app, "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("a deep link reloads into the app, not a 404", async () => {
    const app = await makeApp();
    const response = await get(app, "/jobs/some-id/inspect");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("but an unknown /api path still fails as an API", async () => {
    const app = await makeApp();
    const response = await get(app, "/api/nonsense");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });
});
