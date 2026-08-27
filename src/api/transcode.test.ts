/**
 * `/api/transcode` at the HTTP boundary.
 *
 * `core/transcode` is tested on its own, so what is worth proving here is what
 * only exists in the routes: that **`POST` returns without doing the work**
 * (the whole reason this is a queue), that a batch answers with two lists
 * rather than a failure, that a path trying to leave the library is refused
 * before ffmpeg is handed it, and that **the cost is in the response** — a UI
 * cannot warn about what the server never told it.
 *
 * The queue is built here against a real temp library and a fake ffmpeg, so the
 * suite needs no binary installed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { appDbPath, closeDb, openDb, type Db } from "../core/db";
import { createTranscodeQueue, type TranscodeQueue, type TranscodeRow } from "../core/transcode";
import type { MediaProbe } from "../core/library";
import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { transcodeRoutes } from "./transcode";

let dir: string;
let root: string;
let db: Db;
let queue: TranscodeQueue;
let app: { handle(request: Request): Promise<Response> };

function fakeFfmpeg(): string {
  const path = join(dir, "ffmpeg");
  writeFileSync(
    path,
    ["#!/bin/sh", 'for arg in "$@"; do out="$arg"; done', "echo out_time_us=1000000", 'printf video > "$out"', ""].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function probe(): Promise<Result<MediaProbe, { _tag: string }>> {
  return Result.ok({ path: "x", durationSeconds: 10, bitrate: 1000, formatName: "matroska,webm", width: null, height: null, streams: [] });
}

function put(relative: string, contents = "not really a video"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

const get = (path: string): Promise<Response> => app.handle(new Request(`http://local/api${path}`));

const post = (path: string, body: unknown): Promise<Response> =>
  app.handle(
    new Request(`http://local/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-api-transcode-"));
  root = join(dir, "library");
  mkdirSync(root, { recursive: true });
  put("Videos/Film.mkv");
  put("Videos/Other.mkv");

  db = openDb({ path: appDbPath(dir) });
  queue = createTranscodeQueue({
    db,
    libraryRoot: root,
    probe,
    ffmpegPath: fakeFfmpeg(),
    log: () => undefined,
  });
  const ctx = { db, config: { ...loadConfig({}), libraryDir: root }, transcodes: queue } as AppContext;
  app = new Elysia({ prefix: "/api" }).use(transcodeRoutes(ctx));
});

afterEach(async () => {
  await queue.stop();
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/transcode/presets", () => {
  /**
   * 🔴 The cost is part of the contract. Anything about to offer a button that
   * starts an hour of CPU has to be able to say so first, and it can only say
   * it if the server tells it which presets are the expensive ones.
   */
  test("every preset arrives with its cost and whether it re-encodes", async () => {
    const body = (await (await get("/transcode/presets")).json()) as {
      presets: { id: string; cost: string; reencodesVideo: boolean }[];
      concurrency: number;
    };

    expect(body.presets.length).toBeGreaterThan(0);
    for (const preset of body.presets) {
      expect(preset.cost.length).toBeGreaterThan(20);
      expect(typeof preset.reencodesVideo).toBe("boolean");
    }
    expect(body.presets.some((preset) => preset.reencodesVideo)).toBe(true);
    // ⚠️ Stated rather than inferred: this box also runs Home Assistant.
    expect(body.concurrency).toBe(1);
  });

  test("no preset leaks a raw ffmpeg argument list", async () => {
    const text = await (await get("/transcode/presets")).text();
    expect(text).not.toContain("libx264");
    expect(text).not.toContain("-crf");
  });
});

describe("POST /api/transcode", () => {
  /** 🔴 The entire reason this is a queue and not a request. */
  test("returns immediately, with a queued row and nothing done", async () => {
    const response = await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" });
    const body = (await response.json()) as { queued: TranscodeRow[]; warning?: string };

    expect(response.status).toBe(200);
    expect(body.queued).toHaveLength(1);
    expect(body.queued[0]?.status).toBe("queued");
    expect(body.queued[0]?.outputPath).toBe("Videos/Film (TV).mp4");
    expect(existsSync(join(root, "Videos/Film (TV).mp4"))).toBe(false);
  });

  /** ⚠️ The sentence a confirm dialog needs is in the answer, not only on /presets. */
  test("says what it is about to cost", async () => {
    const body = (await (await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" })).json()) as {
      warning?: string;
    };
    expect(body.warning ?? "").toContain("Re-encoding");
    expect(body.warning ?? "").toContain("One job runs at a time");
  });

  test("a batch answers with two lists rather than failing on the first bad file", async () => {
    const body = (await (
      await post("/transcode", { paths: ["Videos/Film.mkv", "Videos/ghost.mkv", "Videos/Other.mkv"], preset: "tv" })
    ).json()) as { queued: TranscodeRow[]; rejected: { path: string; reason: string }[] };

    expect(body.queued).toHaveLength(2);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.reason.length).toBeGreaterThan(0);
  });

  /** 🔴 This ends in `ffmpeg -i <path>`, which reads whatever it is given. */
  test("a path that leaves the library is refused, and nothing is queued", async () => {
    const body = (await (await post("/transcode", { path: "../../etc/shadow", preset: "tv" })).json()) as {
      queued: TranscodeRow[];
      rejected: { path: string }[];
    };

    expect(body.queued).toHaveLength(0);
    expect(body.rejected).toHaveLength(1);
  });

  test("an unknown preset is rejected by name", async () => {
    const body = (await (await post("/transcode", { path: "Videos/Film.mkv", preset: "h265-please" })).json()) as {
      queued: TranscodeRow[];
      rejected: { reason: string }[];
    };

    expect(body.queued).toHaveLength(0);
    expect(body.rejected[0]?.reason).toContain("h265-please");
  });

  test("naming no file at all is a 409, not an empty success", async () => {
    expect((await post("/transcode", { preset: "tv" })).status).toBe(409);
  });

  test("a body with no preset is a 422", async () => {
    expect((await post("/transcode", { path: "Videos/Film.mkv" })).status).toBe(422);
  });

  /**
   * ⚠️ The default has to be visible in the wire format, because "replace the
   * original" is the one option here that destroys something.
   */
  test("replaceOriginal is off unless it is asked for", async () => {
    const body = (await (await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" })).json()) as {
      queued: TranscodeRow[];
    };
    expect(body.queued[0]?.replaceOriginal).toBe(false);
  });
});

describe("GET /api/transcode", () => {
  test("lists what is queued, newest first, and says what is running", async () => {
    await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" });

    const body = (await (await get("/transcode")).json()) as { jobs: TranscodeRow[]; running: string | null };

    expect(body.jobs).toHaveLength(1);
    expect(body.running).toBeNull();
  });

  test("filters by status", async () => {
    await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" });

    const done = (await (await get("/transcode?status=done")).json()) as { jobs: TranscodeRow[] };

    expect(done.jobs).toHaveLength(0);
  });
});

describe("DELETE /api/transcode/:id", () => {
  test("cancels a queued job", async () => {
    const queued = (await (await post("/transcode", { path: "Videos/Film.mkv", preset: "tv" })).json()) as {
      queued: TranscodeRow[];
    };
    const id = queued.queued[0]?.id ?? "";

    const response = await app.handle(new Request(`http://local/api/transcode/${id}`, { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(((await response.json()) as TranscodeRow).status).toBe("cancelled");
  });

  test("a job that does not exist is a 404", async () => {
    const response = await app.handle(new Request("http://local/api/transcode/nope", { method: "DELETE" }));
    expect(response.status).toBe(404);
  });
});
