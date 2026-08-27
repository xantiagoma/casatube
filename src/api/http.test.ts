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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { CredentialStore } from "../core/credentials";
import { closeDb, openDb, type Db } from "../core/db";
import { JobQueue, openJobQueue, shutdownEmbeddedQueue } from "../core/queue";
import { SourceScheduler } from "../core/scheduler";
import { SourceManager, registryDiscoverer } from "../core/sources";
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

async function makeApp(provider: Provider = fakeProvider(), configOverrides: Record<string, unknown> = {}) {
  db = openDb({ path: join(dir, "casatube.db") });
  queue = await openJobQueue({ db, queueDbPath: join(dir, "queue.db") });
  const watcher = createQueueWatcher(queue, { pollMs: 20, heartbeatMs: 100 });
  const registry = createRegistry({ fallback: provider });
  // Never started here: a scheduler that ticks during an HTTP test would make
  // the job table move on its own.
  const sources = new SourceManager({ db, queue, discover: registryDiscoverer(registry) });
  return createApp(
    {
      db,
      queue,
      registry,
      watcher,
      sources,
      scheduler: new SourceScheduler({ manager: sources }),
      // `key: null` rather than the ambient CREDENTIALS_KEY: a test must not
      // change behaviour because of what happens to be in the environment.
      credentials: new CredentialStore({ db, key: null, tempDir: dir, warn: () => {} }),
      config: { ...loadConfig({}), dataDir: dir, dev: false, ...configOverrides },
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

  interface ListBody {
    jobs: { id: string; url: string; title: string | null }[];
    total: number;
    counts: {
      byStatus: Record<string, number>;
      byBucket: Record<string, number>;
    };
    limit: number;
    offset: number;
  }

  const list = async (app: Awaited<ReturnType<typeof makeApp>>, query = ""): Promise<ListBody> =>
    (await (await get(app, `/api/jobs${query}`)).json()) as ListBody;

  test("🔴 a page says what it is a page of", async () => {
    // Without `total`, "the largest failed download" is "the largest of the
    // page that happened to be fetched" and the screen cannot tell.
    const app = await makeApp();
    for (let i = 0; i < 5; i++) {
      await post(app, "/api/jobs", { url: `https://example.test/v${i}`, destination: "" });
    }

    const body = await list(app, "?limit=2");
    expect(body.jobs).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  test("sort, order and q reach the database", async () => {
    const app = await makeApp();
    await post(app, "/api/jobs", { url: "https://example.test/zoo", destination: "" });
    await post(app, "/api/jobs", { url: "https://example.test/other", destination: "" });

    const searched = await list(app, "?q=zoo");
    expect(searched.total).toBe(1);
    expect(searched.jobs[0]?.url).toBe("https://example.test/zoo");

    const ascending = await list(app, "?sort=date&order=asc");
    expect(ascending.jobs[0]?.url).toBe("https://example.test/zoo");
    const descending = await list(app, "?sort=date&order=desc");
    expect(descending.jobs[0]?.url).toBe("https://example.test/other");
  });

  test("the status counts survive a status filter, because the tiles do", async () => {
    const app = await makeApp();
    await post(app, "/api/jobs", { url: "https://example.test/a", destination: "" });
    await post(app, "/api/jobs", { url: "https://example.test/b", destination: "" });

    const body = await list(app, "?status=done");
    expect(body.jobs).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.counts.byStatus.queued).toBe(2);
    expect(body.counts.byStatus.done).toBe(0);
    // The tabs count the same way: two queued jobs are two active downloads,
    // whichever tab happens to be open.
    expect(body.counts.byBucket.active).toBe(2);
    expect(body.counts.byBucket.completed).toBe(0);
  });

  test("bucket filters the way the tabs do", async () => {
    const app = await makeApp();
    await post(app, "/api/jobs", { url: "https://example.test/a", destination: "" });

    expect((await list(app, "?bucket=active")).jobs).toHaveLength(1);
    expect((await list(app, "?bucket=completed")).jobs).toEqual([]);
    expect((await get(app, "/api/jobs?bucket=nowhere")).status).toBe(422);
  });

  test("a sort key the server does not know is refused, not quietly ignored", async () => {
    // A rejected request is a bug somebody can see. A silently ignored `sort`
    // is a control that moves and changes nothing.
    const app = await makeApp();
    expect((await get(app, "/api/jobs?sort=banana")).status).toBe(422);
    expect((await get(app, "/api/jobs?order=sideways")).status).toBe(422);
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

/**
 * 🔴 The route that looks at the disk.
 *
 * Every test here is about the same distinction, from a different angle: a file
 * that is gone must read `missing`, and a *library* that is gone must read
 * `unknown` — and the second one must never be reported as the first.
 */
describe("POST /api/jobs/file-state", () => {
  let library: string;

  /** A finished job whose file is (or is not) at `<library>/Videos/<name>`. */
  async function finishedJob(app: Awaited<ReturnType<typeof makeApp>>, name: string): Promise<string> {
    const created = await post(app, "/api/jobs", { url: `https://example.com/${name}`, destination: "Videos" });
    const { job } = (await created.json()) as { job: { id: string } };
    const id = job.id;
    const done = await queue.update(id, { status: "done", outputFile: join(library, "Videos", name) });
    if (Result.isError(done)) throw new Error("could not finish the job");
    return id;
  }

  function put(relative: string, contents = "0123456789"): void {
    const absolute = join(library, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  beforeEach(() => {
    library = mkdtempSync(join(tmpdir(), "casatube-http-library-"));
  });

  afterEach(() => {
    rmSync(library, { recursive: true, force: true });
  });

  test("a file that is on disk comes back present", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: library });
    put("Videos/Talk.mkv");
    const id = await finishedJob(app, "Talk.mkv");

    const response = await post(app, "/api/jobs/file-state", { ids: [id] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { states: { id: string; state: string; size?: number }[]; budgetMs: number };
    expect(body.states).toHaveLength(1);
    expect(body.states[0]?.state).toBe("present");
    expect(body.states[0]?.size).toBe(10);
    expect(body.budgetMs).toBeGreaterThan(0);
  });

  test("🔴 a file deleted outside CasaTube comes back missing", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: library });
    put("Videos/Talk.mkv");
    put("Videos/Other.mkv");
    const id = await finishedJob(app, "Talk.mkv");
    rmSync(join(library, "Videos/Talk.mkv"));

    const response = await post(app, "/api/jobs/file-state", { ids: [id] });
    const body = (await response.json()) as { states: { state: string }[] };
    expect(body.states[0]?.state).toBe("missing");
  });

  test("🔴 a library that is not there is 200 full of unknown, not a 503", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: join(library, "not-mounted") });
    const id = await finishedJob(app, "Talk.mkv");

    const response = await post(app, "/api/jobs/file-state", { ids: [id] });
    // 🔴 A 200. The caller is drawing a badge per row and needs an answer for
    // each one; an error status would leave every row with nothing to render.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { states: { state: string; reason?: string; detail?: string }[] };
    expect(body.states[0]?.state).toBe("unknown");
    expect(body.states[0]?.reason).toBe("mount-unavailable");
    expect(typeof body.states[0]?.detail).toBe("string");
  });

  test("an id the queue has never heard of is simply absent from the answer", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: library });
    put("Videos/Talk.mkv");
    const id = await finishedJob(app, "Talk.mkv");

    const response = await post(app, "/api/jobs/file-state", { ids: [id, "not-a-job"] });
    const body = (await response.json()) as { states: { id: string }[] };
    expect(body.states.map((state) => state.id)).toEqual([id]);
  });

  test("an empty list of ids does no work and does not fail", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: library });
    const response = await post(app, "/api/jobs/file-state", { ids: [] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { states: unknown[]; checked: number };
    expect(body.states).toEqual([]);
    expect(body.checked).toBe(0);
  });

  test("🔴 an empty list of ids does not answer about every job in the table", async () => {
    const app = await makeApp(fakeProvider(), { libraryDir: library });
    put("Videos/Talk.mkv");
    await finishedJob(app, "Talk.mkv");

    const response = await post(app, "/api/jobs/file-state", { ids: [] });
    const body = (await response.json()) as { states: unknown[] };
    expect(body.states).toEqual([]);
  });
});

describe("POST /api/jobs/:id/redownload", () => {
  test("queues a second job with the same url, destination and preferences", async () => {
    const app = await makeApp();
    const created = await post(app, "/api/jobs", {
      url: "https://example.com/a",
      destination: "Videos",
      preferences: { maxResolution: 720 },
    });
    const first = ((await created.json()) as { job: { id: string } }).job;
    if (Result.isError(await queue.update(first.id, { status: "done", outputFile: "/library/Videos/A.mkv" }))) {
      throw new Error("could not finish the job");
    }

    const response = await post(app, `/api/jobs/${first.id}/redownload`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      job: { id: string; url: string; destination: string; preferences: { maxResolution: number }; status: string };
    };
    // 🔴 `queued`, not `duplicate`: the finished job it is replacing is exactly
    // the one duplicate detection would otherwise match.
    expect(body.outcome).toBe("queued");
    expect(body.job.id).not.toBe(first.id);
    expect(body.job.url).toBe("https://example.com/a");
    expect(body.job.destination).toBe("Videos");
    expect(body.job.preferences.maxResolution).toBe(720);
    expect(body.job.status).toBe("queued");
  });

  test("the original job is left exactly as it was", async () => {
    const app = await makeApp();
    const created = await post(app, "/api/jobs", { url: "https://example.com/a", destination: "Videos" });
    const first = ((await created.json()) as { job: { id: string } }).job;
    await queue.update(first.id, { status: "done", outputFile: "/library/Videos/A.mkv" });

    await post(app, `/api/jobs/${first.id}/redownload`);
    const still = await queue.get(first.id);
    if (Result.isError(still)) throw new Error("the original job vanished");
    expect(still.value.status).toBe("done");
    expect(still.value.outputFile).toBe("/library/Videos/A.mkv");
  });

  test("a job that is still running is refused rather than downloaded twice", async () => {
    const app = await makeApp();
    const created = await post(app, "/api/jobs", { url: "https://example.com/a", destination: "Videos" });
    const first = ((await created.json()) as { job: { id: string } }).job;
    await queue.update(first.id, { status: "downloading" });

    const response = await post(app, `/api/jobs/${first.id}/redownload`);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("a job that does not exist is a 404, not a new download", async () => {
    const app = await makeApp();
    const response = await post(app, "/api/jobs/nope/redownload");
    expect(response.status).toBe(404);
  });
});
