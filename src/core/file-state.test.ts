/**
 * File state, against a **real** library on a real disk.
 *
 * The one thing worth checking here cannot be checked against a stub: that a
 * file removed behind CasaTube's back reads differently from one CasaTube
 * itself moved, and that both read differently from a library nobody can see.
 * So every test below deletes something for real, and the interesting
 * assertions are the ones about what is *not* said.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { jobFileStates, libraryRelativeOutput } from "./file-state";
import { openLibrary, type Library } from "./library";
import { DEFAULT_PREFERENCES, type Job, type JobStatus } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-file-state-"));
});

afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

function put(relative: string, contents = "0123456789"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function open(overrides: Partial<Parameters<typeof openLibrary>[0]> = {}): Library {
  return openLibrary({ root, log: () => {}, ...overrides });
}

let counter = 0;

/** A finished job whose output landed at `<root>/<destination>/<name>`. */
function job(fields: {
  status?: JobStatus;
  destination?: string;
  outputFile?: string | null;
  libraryRoot?: string;
}): Job {
  counter += 1;
  const destination = fields.destination ?? "Videos";
  const outputFile =
    fields.outputFile === undefined
      ? join(fields.libraryRoot ?? root, destination, "Talk.mkv")
      : fields.outputFile;
  return {
    id: `job-${counter}`,
    url: "https://example.com/watch?v=1",
    provider: "ytdlp",
    destination,
    title: "A Talk",
    status: fields.status ?? "done",
    stages: [],
    priority: "normal",
    attempts: 0,
    maxAttempts: 3,
    paused: false,
    leaseUntil: null,
    claimedBy: null,
    notBefore: null,
    progress: 100,
    totalBytes: 10,
    doneBytes: 10,
    speed: null,
    eta: null,
    thumbnail: null,
    duration: null,
    source: null,
    plan: null,
    preferences: DEFAULT_PREFERENCES,
    pluginsOff: [],
    fingerprint: `fp-${counter}`,
    log: [],
    error: null,
    outputFile,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  } as Job;
}

describe("libraryRelativeOutput", () => {
  test("strips the root from the absolute path the worker recorded", () => {
    expect(libraryRelativeOutput("/library/Videos/A Talk.mkv", "/library", "Videos")).toBe("Videos/A Talk.mkv");
  });

  test("a file in the library root has no folder", () => {
    expect(libraryRelativeOutput("/library/A Talk.mkv", "/library", "")).toBe("A Talk.mkv");
  });

  test("a trailing slash on the root does not eat the first character", () => {
    expect(libraryRelativeOutput("/library/Videos/A Talk.mkv", "/library/", "Videos")).toBe("Videos/A Talk.mkv");
  });

  test("🔴 a root that has moved falls back to destination + filename", () => {
    // Recorded inside a container at /library, read on the host at /mnt/nas.
    expect(libraryRelativeOutput("/library/Videos/A Talk.mkv", "/mnt/nas", "Videos")).toBe("Videos/A Talk.mkv");
  });

  test("a root that has moved, and a file in the library root", () => {
    expect(libraryRelativeOutput("/library/A Talk.mkv", "/mnt/nas", "")).toBe("A Talk.mkv");
  });

  test("a destination with leading or trailing slashes normalises to one form", () => {
    expect(libraryRelativeOutput("/elsewhere/A Talk.mkv", "/mnt/nas", "/Videos/")).toBe("Videos/A Talk.mkv");
  });

  test("a path with no filename in it is refused rather than guessed at", () => {
    expect(libraryRelativeOutput("/library/", "/library", "Videos")).toBeNull();
  });

  test("a prefix that is not a path boundary is not a match", () => {
    // /library-old is not inside /library, however it sorts as a string.
    expect(libraryRelativeOutput("/library-old/Videos/A Talk.mkv", "/library", "Videos")).toBe("Videos/A Talk.mkv");
  });
});

describe("jobFileStates", () => {
  test("a finished job whose file is on disk is present, with its size", async () => {
    put("Videos/Talk.mkv");
    const report = await jobFileStates([job({})], open());
    expect(report.states[0]?.state).toBe("present");
    expect(report.states[0]?.size).toBe(10);
    expect(report.states[0]?.path).toBe("Videos/Talk.mkv");
  });

  test("🔴 a file deleted outside CasaTube is missing — this is the whole point", async () => {
    put("Videos/Talk.mkv");
    put("Videos/Something Else.mkv");
    rmSync(join(root, "Videos/Talk.mkv"));

    const report = await jobFileStates([job({})], open());
    expect(report.states[0]?.state).toBe("missing");
  });

  test("a file CasaTube moved to the trash is trashed, and carries the entry id", async () => {
    put("Videos/Talk.mkv");
    put("Videos/Something Else.mkv");
    const library = open();
    const removed = await library.remove("Videos/Talk.mkv", { reason: "test" });
    if (Result.isError(removed)) throw new Error("the delete failed");

    const report = await jobFileStates([job({})], library);
    expect(report.states[0]?.state).toBe("trashed");
    expect(report.states[0]?.trashId).toBe(removed.value.id);
  });

  test("🔴 a re-download over a trashed name is present — the disk decides, not the journal", async () => {
    put("Videos/Talk.mkv");
    put("Videos/Something Else.mkv");
    const library = open();
    if (Result.isError(await library.remove("Videos/Talk.mkv", { reason: "test" }))) {
      throw new Error("the delete failed");
    }
    // The same title, downloaded again into the same place.
    put("Videos/Talk.mkv", "new bytes");

    const report = await jobFileStates([job({})], library);
    expect(report.states[0]?.state).toBe("present");
  });

  test("a job that finished without recording a path is none", async () => {
    put("Videos/Anything.mkv");
    const report = await jobFileStates([job({ outputFile: null })], open());
    expect(report.states[0]?.state).toBe("none");
    expect(report.states[0]?.reason).toBeUndefined();
  });

  test("a job that has not finished is unknown, and says so without alarm", async () => {
    put("Videos/Anything.mkv");
    const report = await jobFileStates([job({ status: "downloading", outputFile: null })], open());
    expect(report.states[0]?.state).toBe("unknown");
    expect(report.states[0]?.reason).toBe("not-finished");
  });

  test("a job that has not finished costs no disk access at all", async () => {
    const report = await jobFileStates(
      [job({ status: "queued", outputFile: null }), job({ status: "downloading", outputFile: null })],
      // A root that does not exist: reaching for it would turn these unknown.
      openLibrary({ root: join(root, "nowhere") }),
    );
    expect(report.states.map((state) => state.reason)).toEqual(["not-finished", "not-finished"]);
    expect(report.checked).toBe(0);
  });

  test("🔴 a library that is not mounted is unknown, never missing", async () => {
    const report = await jobFileStates(
      [job({ libraryRoot: "/library" })],
      openLibrary({ root: join(root, "not-mounted") }),
    );
    expect(report.states[0]?.state).toBe("unknown");
    expect(report.states[0]?.reason).toBe("mount-unavailable");
  });

  test("🔴 an empty library root is unknown, never missing", async () => {
    const report = await jobFileStates([job({})], open());
    expect(report.states[0]?.state).toBe("unknown");
    expect(report.states[0]?.reason).toBe("library-empty");
  });

  test("🔴 a library that refuses to be read is unknown, never missing", async () => {
    put("Videos/Talk.mkv");
    chmodSync(root, 0o000);
    const report = await jobFileStates([job({})], open());
    chmodSync(root, 0o755);
    expect(report.states[0]?.state).toBe("unknown");
    expect(report.states[0]?.reason).toBe("mount-unavailable");
  });

  test("🔴 an absence that the trash cannot be asked about is unknown, never missing", async () => {
    put("Videos/Kept.mkv");
    // A trash directory that exists and cannot be read is the case that matters:
    // `listTrash` treats a *missing* one as an empty trash, correctly.
    mkdirSync(join(root, ".trash"), { recursive: true });
    writeFileSync(join(root, ".trash/trash.jsonl"), "");
    chmodSync(join(root, ".trash"), 0o000);
    const report = await jobFileStates([job({})], open());
    chmodSync(join(root, ".trash"), 0o755);

    expect(report.states[0]?.state).toBe("unknown");
    expect(report.states[0]?.reason).toBe("trash-unreadable");
  });

  test("the answers come back in the order the jobs were given, one per job", async () => {
    put("Videos/Talk.mkv");
    put("Videos/Other.mkv");
    const jobs = [
      job({ outputFile: join(root, "Videos/Talk.mkv") }),
      job({ outputFile: join(root, "Videos/Gone.mkv") }),
      job({ status: "failed", outputFile: null }),
      job({ outputFile: null }),
    ];
    const report = await jobFileStates(jobs, open());
    expect(report.states.map((state) => state.state)).toEqual(["present", "missing", "unknown", "none"]);
    expect(report.states.map((state) => state.id)).toEqual(jobs.map((one) => one.id));
  });

  test("two jobs pointing at one file cost one stat", async () => {
    put("Videos/Talk.mkv");
    const same = join(root, "Videos/Talk.mkv");
    const report = await jobFileStates([job({ outputFile: same }), job({ outputFile: same })], open());
    expect(report.checked).toBe(1);
    expect(report.states.map((state) => state.state)).toEqual(["present", "present"]);
  });

  test("two hundred finished jobs are answered in one batch, and the cost is reported", async () => {
    const jobs = [];
    for (let index = 0; index < 200; index += 1) {
      put(`Videos/Talk ${index}.mkv`);
      jobs.push(job({ outputFile: join(root, `Videos/Talk ${index}.mkv`) }));
    }
    const report = await jobFileStates(jobs, open());
    expect(report.checked).toBe(200);
    expect(report.exhausted).toBe(false);
    expect(report.states.every((state) => state.state === "present")).toBe(true);
  });
});
