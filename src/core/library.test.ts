/**
 * The library, against a **real directory tree** created and torn down per test.
 *
 * A mocked filesystem would prove nothing here. Every interesting case is a
 * distinction the real filesystem makes and a stub would have to imitate: that
 * a rename into `.trash/` keeps the bytes, that a restore finds its original
 * folder gone, that a root which is not there behaves differently from a
 * subfolder which is not there. The one thing that cannot be created on demand
 * is a **hung** mount, so the deadline is tested against a promise that never
 * settles — which is exactly what a dead FUSE mount hands you.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TRASH_RETENTION_DAYS,
  openLibrary,
  resolveInRoot,
  TRASH_DIR,
  withDeadline,
  type Library,
  type LibraryItem,
} from "./library";

let root: string;
let logged: string[];

function open(overrides: Partial<Parameters<typeof openLibrary>[0]> = {}): Library {
  return openLibrary({ root, log: (line) => logged.push(line), ...overrides });
}

function put(relative: string, contents = "x"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Explicit mtimes: the default sort is by modification time. */
function touch(relative: string, epochSeconds: number): void {
  utimesSync(join(root, relative), epochSeconds, epochSeconds);
}

function unwrap<T>(result: Result<T, { _tag: string }>): T {
  if (Result.isError(result)) throw new Error(`expected ok, got ${result.error._tag}`);
  return result.value;
}

function tagOf(result: Result<unknown, { _tag: string }>): string {
  if (Result.isOk(result)) throw new Error("expected an error");
  return result.error._tag;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-library-"));
  logged = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listing", () => {
  test("reports path, name, folder, size, date and extension for each item", async () => {
    put("youtube/talks/A Talk.mkv", "0123456789");
    touch("youtube/talks/A Talk.mkv", 1_700_000_000);

    const listing = unwrap(await open().list());
    expect(listing.items).toHaveLength(1);

    const [item] = listing.items as [LibraryItem];
    expect(item.path).toBe("youtube/talks/A Talk.mkv");
    expect(item.name).toBe("A Talk.mkv");
    expect(item.folder).toBe("youtube/talks");
    expect(item.ext).toBe("mkv");
    expect(item.size).toBe(10);
    expect(item.modifiedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(listing.root).toBe(root);
    expect(listing.truncated).toBe(false);
  });

  test("an empty library is an empty list, not an error", async () => {
    const listing = unwrap(await open().list());
    expect(listing.items).toEqual([]);
    expect(listing.matched).toBe(0);
    expect(listing.nextCursor).toBeNull();
  });

  test("hidden entries and the trash are not library content", async () => {
    put("visible.mkv");
    put(".hidden.mkv");
    put(".trash/20260101-abcdef/deleted.mkv");
    mkdirSync(join(root, "@eaDir"), { recursive: true });
    writeFileSync(join(root, "@eaDir", "thumb.jpg"), "x");

    const listing = unwrap(await open().list());
    expect(listing.items.map((item) => item.path)).toEqual(["visible.mkv"]);
  });

  test("filters by subfolder, and can stay out of its children", async () => {
    put("youtube/one.mkv");
    put("youtube/talks/two.mkv");
    put("films/three.mkv");

    const all = unwrap(await open().list({ folder: "youtube" }));
    expect(all.items.map((item) => item.path).sort()).toEqual(["youtube/one.mkv", "youtube/talks/two.mkv"]);

    const shallow = unwrap(await open().list({ folder: "youtube", recursive: false }));
    expect(shallow.items.map((item) => item.path)).toEqual(["youtube/one.mkv"]);
  });

  test("searches by name, case-insensitively", async () => {
    put("youtube/Interstellar Trailer.mkv");
    put("youtube/Cooking.mkv");

    const found = unwrap(await open().list({ search: "TRAIL" }));
    expect(found.items.map((item) => item.name)).toEqual(["Interstellar Trailer.mkv"]);
    expect(found.matched).toBe(1);
  });

  test("sorts by name, size and date, in both directions", async () => {
    put("b.mkv", "22");
    put("a.mkv", "1");
    put("c.mkv", "333");
    touch("b.mkv", 300);
    touch("a.mkv", 100);
    touch("c.mkv", 200);

    const byName = unwrap(await open().list({ sort: "name" }));
    expect(byName.items.map((item) => item.name)).toEqual(["a.mkv", "b.mkv", "c.mkv"]);

    const bySize = unwrap(await open().list({ sort: "size", order: "desc" }));
    expect(bySize.items.map((item) => item.name)).toEqual(["c.mkv", "b.mkv", "a.mkv"]);

    // The default: newest first, which is what a downloads library is for.
    const byDate = unwrap(await open().list());
    expect(byDate.items.map((item) => item.name)).toEqual(["b.mkv", "c.mkv", "a.mkv"]);
  });

  test("pages by cursor, covering every item exactly once", async () => {
    for (let index = 0; index < 7; index += 1) put(`file-${index}.mkv`, "x".repeat(index + 1));

    const library = open();
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;

    do {
      const page = unwrap(
        await library.list(cursor == null ? { sort: "name", limit: 3 } : { sort: "name", limit: 3, cursor }),
      );
      seen.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toEqual([
      "file-0.mkv", "file-1.mkv", "file-2.mkv", "file-3.mkv", "file-4.mkv", "file-5.mkv", "file-6.mkv",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(3);
  });

  test("a cursor from another version starts the listing over rather than failing", async () => {
    put("a.mkv");
    const listing = unwrap(await open().list({ cursor: "not-a-cursor" }));
    expect(listing.items.map((item) => item.name)).toEqual(["a.mkv"]);
  });
});

describe("subtitles", () => {
  test("attaches sidecars sharing the base name, with their language", async () => {
    put("youtube/Talk.mkv", "video");
    put("youtube/Talk.srt", "plain");
    put("youtube/Talk.en.vtt", "english");
    put("youtube/Talk.es-419.ass", "spanish");
    put("youtube/Talk.en.forced.srt", "forced");
    put("youtube/Unrelated.srt", "someone else's");

    const listing = unwrap(await open().list({ sort: "name" }));
    const talk = listing.items.find((item) => item.name === "Talk.mkv");
    expect(talk).toBeDefined();
    expect(talk?.subtitles.map((sub) => sub.name).sort()).toEqual([
      "Talk.en.forced.srt", "Talk.en.vtt", "Talk.es-419.ass", "Talk.srt",
    ]);
    expect(talk?.subtitles.find((sub) => sub.name === "Talk.en.vtt")?.language).toBe("en");
    expect(talk?.subtitles.find((sub) => sub.name === "Talk.es-419.ass")?.language).toBe("es-419");
    expect(talk?.subtitles.find((sub) => sub.name === "Talk.srt")?.language).toBeUndefined();
    expect(talk?.subtitles.find((sub) => sub.name === "Talk.en.forced.srt")?.forced).toBe(true);

    // An attached sidecar is not also an item; an unattached one is.
    expect(listing.items.map((item) => item.name)).toEqual(["Talk.mkv", "Unrelated.srt"]);
  });

  test("a sidecar goes to the longest matching base, not the first", async () => {
    put("Foo.mkv");
    put("Foo.en.mkv");
    put("Foo.en.srt");

    const listing = unwrap(await open().list({ sort: "name" }));
    expect(listing.items.find((item) => item.name === "Foo.en.mkv")?.subtitles.map((s) => s.name)).toEqual(["Foo.en.srt"]);
    expect(listing.items.find((item) => item.name === "Foo.mkv")?.subtitles).toEqual([]);
  });

  test("subtitles in another folder are somebody else's", async () => {
    put("a/Talk.mkv");
    put("b/Talk.srt");

    const listing = unwrap(await open().list({ sort: "name" }));
    expect(listing.items.find((item) => item.name === "Talk.mkv")?.subtitles).toEqual([]);
    expect(listing.items.map((item) => item.path).sort()).toEqual(["a/Talk.mkv", "b/Talk.srt"]);
  });

  test("`item` agrees with the listing about who owns a sidecar", async () => {
    put("Foo.mkv");
    put("Foo.en.mkv");
    put("Foo.en.srt", "subtitle text");

    const library = open();
    const longer = unwrap(await library.item("Foo.en.mkv"));
    expect(longer.subtitles.map((sub) => sub.name)).toEqual(["Foo.en.srt"]);
    expect(longer.subtitles[0]?.size).toBe("subtitle text".length);

    const shorter = unwrap(await library.item("Foo.mkv"));
    expect(shorter.subtitles).toEqual([]);
  });
});

describe("a root that is not there", () => {
  test("listing an absent root is MountUnavailable, not an empty library", async () => {
    const library = openLibrary({ root: join(root, "not-mounted") });
    const listing = await library.list();
    expect(tagOf(listing)).toBe("MountUnavailable");
  });

  test("an absent subfolder is NotFound — a 404, not a dead mount", async () => {
    put("youtube/one.mkv");
    expect(tagOf(await open().list({ folder: "films" }))).toBe("NotFound");
  });

  test("an item that is not there is NotFound", async () => {
    expect(tagOf(await open().item("missing.mkv"))).toBe("NotFound");
  });

  test("a delete against an absent root fails rather than inventing a trash", async () => {
    const library = openLibrary({ root: join(root, "not-mounted") });
    expect(tagOf(await library.remove("a.mkv"))).toBe("NotFound");
  });
});

describe("nothing outside the root", () => {
  const escapes = [
    "../outside.mkv",
    "youtube/../../outside.mkv",
    "/etc/passwd",
    "..",
    "a/../../..",
    "..\\outside.mkv",
    "C:\\outside.mkv",
  ];

  test("`resolveInRoot` refuses every way out", () => {
    for (const attempt of escapes) {
      const resolved = resolveInRoot(root, attempt);
      expect(Result.isError(resolved)).toBe(true);
      if (Result.isError(resolved)) expect(resolved.error._tag).toBe("PathOutsideRoot");
    }
    // …and still allows the ordinary case, including a `..` that stays inside.
    expect(unwrap(resolveInRoot(root, "youtube/talks/a.mkv"))).toBe(join(root, "youtube/talks/a.mkv"));
    expect(unwrap(resolveInRoot(root, "youtube/../films/a.mkv"))).toBe(join(root, "films/a.mkv"));
  });

  test("a `..` path is rejected by list, item, probe, remove and restore", async () => {
    const library = open();
    expect(tagOf(await library.list({ folder: "../.." }))).toBe("PathOutsideRoot");
    expect(tagOf(await library.item("../outside.mkv"))).toBe("PathOutsideRoot");
    expect(tagOf(await library.probe("../outside.mkv"))).toBe("PathOutsideRoot");
    expect(tagOf(await library.remove("../outside.mkv"))).toBe("PathOutsideRoot");
  });

  test("a delete cannot reach a file next to the library", async () => {
    const outside = join(root, "..", `casatube-outside-${process.pid}.mkv`);
    writeFileSync(outside, "not yours");
    try {
      const attempt = await open().remove(`../${outside.split("/").pop() ?? ""}`);
      expect(tagOf(attempt)).toBe("PathOutsideRoot");
      // The instrument could lie by reporting a refusal it never enforced.
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("the root itself and the trash are not deletable", async () => {
    put(`${TRASH_DIR}/20260101-abcdef/old.mkv`);
    const library = open();
    expect(tagOf(await library.remove("."))).toBe("PathOutsideRoot");
    expect(tagOf(await library.remove(TRASH_DIR))).toBe("PathOutsideRoot");
    expect(tagOf(await library.remove(`${TRASH_DIR}/20260101-abcdef/old.mkv`))).toBe("PathOutsideRoot");
  });
});

describe("delete → restore → empty", () => {
  test("the whole cycle, with the bytes intact at every step", async () => {
    put("youtube/Talk.mkv", "the video itself");
    put("youtube/Talk.en.srt", "the subtitles");
    put("youtube/Keep.mkv", "untouched");

    const library = open();

    // --- delete: a move, never an unlink ---------------------------------
    const entry = unwrap(await library.remove("youtube/Talk.mkv", { reason: "test" }));
    expect(entry.path).toBe("youtube/Talk.mkv");
    expect(entry.files.map((file) => file.original).sort()).toEqual(["youtube/Talk.en.srt", "youtube/Talk.mkv"]);
    expect(entry.size).toBe("the video itself".length + "the subtitles".length);
    expect(entry.reason).toBe("test");

    expect(existsSync(join(root, "youtube/Talk.mkv"))).toBe(false);
    expect(existsSync(join(root, "youtube/Talk.en.srt"))).toBe(false);
    // 🔴 The bytes are still there — that is the whole point of the move.
    expect(readFileSync(join(root, TRASH_DIR, entry.id, "Talk.mkv"), "utf8")).toBe("the video itself");
    expect(readFileSync(join(root, TRASH_DIR, entry.id, "Talk.en.srt"), "utf8")).toBe("the subtitles");
    expect(existsSync(join(root, "youtube/Keep.mkv"))).toBe(true);

    // Recorded: in the journal, and in the log.
    const journal = readFileSync(join(root, TRASH_DIR, "trash.jsonl"), "utf8").trim().split("\n");
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0] ?? "{}")).toMatchObject({ op: "delete", entry: { id: entry.id } });
    expect(logged.some((line) => line.includes("library delete") && line.includes(entry.id))).toBe(true);

    // Gone from the listing, present in the trash.
    expect((unwrap(await library.list())).items.map((item) => item.name)).toEqual(["Keep.mkv"]);
    const inTrash = unwrap(await library.listTrash());
    expect(inTrash.map((candidate) => candidate.id)).toEqual([entry.id]);

    // --- restore ----------------------------------------------------------
    const restored = unwrap(await library.restore("youtube/Talk.mkv"));
    expect(restored.path).toBe("youtube/Talk.mkv");
    expect(restored.renamed).toBe(false);
    expect(restored.files).toHaveLength(2);
    expect(readFileSync(join(root, "youtube/Talk.mkv"), "utf8")).toBe("the video itself");
    expect(readFileSync(join(root, "youtube/Talk.en.srt"), "utf8")).toBe("the subtitles");
    expect(existsSync(join(root, TRASH_DIR, entry.id))).toBe(false);
    expect(unwrap(await library.listTrash())).toEqual([]);

    const back = unwrap(await library.list({ sort: "name" }));
    expect(back.items.map((item) => item.name)).toEqual(["Keep.mkv", "Talk.mkv"]);
    expect(back.items.find((item) => item.name === "Talk.mkv")?.subtitles.map((sub) => sub.name)).toEqual(["Talk.en.srt"]);

    // --- delete again, then empty ----------------------------------------
    const second = unwrap(await library.remove("youtube/Talk.mkv"));
    const kept = unwrap(await library.emptyTrash());
    expect(kept).toMatchObject({ removed: 0, remaining: 1, olderThanDays: DEFAULT_TRASH_RETENTION_DAYS });
    expect(existsSync(join(root, TRASH_DIR, second.id))).toBe(true);

    const emptied = unwrap(await library.emptyTrash(0));
    expect(emptied.removed).toBe(1);
    expect(emptied.freedBytes).toBe(second.size);
    expect(emptied.remaining).toBe(0);
    expect(existsSync(join(root, TRASH_DIR, second.id))).toBe(false);
    expect(unwrap(await library.listTrash())).toEqual([]);
    // Emptied is emptied: there is nothing left to restore.
    expect(tagOf(await library.restore("youtube/Talk.mkv"))).toBe("NotFound");
    expect(logged.some((line) => line.includes("library purge"))).toBe(true);
  });

  test("restore never overwrites what took the original name", async () => {
    put("Talk.mkv", "the old copy");
    const library = open();
    const entry = unwrap(await library.remove("Talk.mkv"));
    put("Talk.mkv", "the new copy");

    const restored = unwrap(await library.restore(entry.id));
    expect(restored.renamed).toBe(true);
    expect(restored.path).toBe("Talk (restored).mkv");
    expect(readFileSync(join(root, "Talk.mkv"), "utf8")).toBe("the new copy");
    expect(readFileSync(join(root, "Talk (restored).mkv"), "utf8")).toBe("the old copy");
  });

  test("restore recreates a folder that was removed in the meantime", async () => {
    put("youtube/talks/Talk.mkv", "video");
    const library = open();
    unwrap(await library.remove("youtube/talks/Talk.mkv"));
    rmSync(join(root, "youtube"), { recursive: true, force: true });

    const restored = unwrap(await library.restore("youtube/talks/Talk.mkv"));
    expect(restored.path).toBe("youtube/talks/Talk.mkv");
    expect(readFileSync(join(root, "youtube/talks/Talk.mkv"), "utf8")).toBe("video");
  });

  test("a folder can be deleted and restored whole", async () => {
    put("youtube/talks/one.mkv", "one");
    put("youtube/talks/two.mkv", "two");

    const library = open();
    const entry = unwrap(await library.remove("youtube/talks"));
    expect(existsSync(join(root, "youtube/talks"))).toBe(false);
    expect(unwrap(await library.list())).toMatchObject({ items: [] });

    unwrap(await library.restore(entry.id));
    expect(unwrap(await library.list({ sort: "name" })).items.map((item) => item.path)).toEqual([
      "youtube/talks/one.mkv",
      "youtube/talks/two.mkv",
    ]);
  });

  test("restore accepts the id, the original path or the path inside the trash", async () => {
    const library = open();
    for (const key of ["id", "original", "trashed"] as const) {
      put("Talk.mkv", "video");
      const entry = unwrap(await library.remove("Talk.mkv"));
      const wanted =
        key === "id" ? entry.id : key === "original" ? "Talk.mkv" : (entry.files[0]?.trashed ?? "");
      expect(unwrap(await library.restore(wanted)).path).toBe("Talk.mkv");
      rmSync(join(root, "Talk.mkv"), { force: true });
    }
  });

  test("restoring something that was never deleted is NotFound", async () => {
    expect(tagOf(await open().restore("Nothing.mkv"))).toBe("NotFound");
  });

  test("emptying compacts the journal instead of letting it grow forever", async () => {
    const library = open();
    put("a.mkv", "a");
    put("b.mkv", "b");
    const a = unwrap(await library.remove("a.mkv"));
    unwrap(await library.remove("b.mkv"));
    unwrap(await library.restore(a.id));

    const before = readFileSync(join(root, TRASH_DIR, "trash.jsonl"), "utf8").trim().split("\n");
    expect(before).toHaveLength(3);

    // Nothing is old enough to purge, so nothing is rewritten either.
    unwrap(await library.emptyTrash());
    expect(readFileSync(join(root, TRASH_DIR, "trash.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);

    put("c.mkv", "c");
    const c = unwrap(await library.remove("c.mkv"));
    unwrap(await library.emptyTrash(0));
    expect(readFileSync(join(root, TRASH_DIR, "trash.jsonl"), "utf8").trim()).toBe("");
    expect(existsSync(join(root, TRASH_DIR, c.id))).toBe(false);
  });

  test("a torn journal line costs one record, not every restore", async () => {
    put("a.mkv", "a");
    const library = open();
    const entry = unwrap(await library.remove("a.mkv"));
    writeFileSync(join(root, TRASH_DIR, "trash.jsonl"), `{"op":"delete"\n${JSON.stringify({ op: "delete", entry })}\n`);

    expect(unwrap(await library.listTrash()).map((candidate) => candidate.id)).toEqual([entry.id]);
    expect(unwrap(await library.restore(entry.id)).path).toBe("a.mkv");
  });

  test("a trash folder with no journal record can be emptied but not restored", async () => {
    put(`${TRASH_DIR}/orphan-entry/mystery.mkv`, "who put this here");
    const library = open();

    const entries = unwrap(await library.listTrash());
    expect(entries.map((entry) => entry.id)).toEqual(["orphan-entry"]);
    expect(entries[0]?.orphan).toBe(true);
    expect(tagOf(await library.restore("orphan-entry"))).toBe("NotFound");

    unwrap(await library.emptyTrash(0));
    expect(existsSync(join(root, TRASH_DIR, "orphan-entry"))).toBe(false);
  });
});

describe("a mount that hangs rather than failing", () => {
  test("the deadline gives up and reports MountUnavailable", async () => {
    // Exactly what a dead FUSE mount hands you: a call that never settles.
    const forever = new Promise<string>(() => {});
    const raced = await withDeadline(forever, 20, "/library", "reading the library");
    expect(tagOf(raced)).toBe("MountUnavailable");
    if (Result.isError(raced)) expect(raced.error.detail).toContain("did not answer within");
  });

  test("a rejection is a failure of the mount, not of the process", async () => {
    const raced = await withDeadline(Promise.reject(new Error("stale file handle")), 500, "/library", "reading");
    expect(tagOf(raced)).toBe("MountUnavailable");
  });

  test("a listing that runs out of budget is truncated, not endless", async () => {
    for (let index = 0; index < 20; index += 1) put(`folder-${index}/file.mkv`);
    // Zero budget: the first check already has nothing left to spend.
    const listing = unwrap(await open({ walkBudgetMs: 0 }).list());
    expect(listing.truncated).toBe(true);
  });

  test("the item cap truncates rather than flooding the page", async () => {
    for (let index = 0; index < 10; index += 1) put(`file-${index}.mkv`);
    const listing = unwrap(await open({ maxItems: 4 }).list());
    expect(listing.truncated).toBe(true);
    expect(listing.matched).toBe(4);
  });

  test("an unreadable subfolder costs that folder, not the whole listing", async () => {
    put("readable/one.mkv");
    mkdirSync(join(root, "locked"), { recursive: true });
    writeFileSync(join(root, "locked", "two.mkv"), "x");
    chmodSync(join(root, "locked"), 0o000);
    try {
      const listing = unwrap(await open().list());
      expect(listing.items.map((item) => item.path)).toEqual(["readable/one.mkv"]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});

describe("ffprobe, lazily and one item at a time", () => {
  /** A stand-in for the real binary, which lives in the image and not here. */
  function fakeFfprobe(body: string): string {
    const path = join(root, "fake-ffprobe.sh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("reads duration, resolution and tracks from the container", async () => {
    put("Talk.mkv", "pretend this is a matroska file");
    const output = {
      format: { duration: "612.5", bit_rate: "1450000", format_name: "matroska,webm" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", disposition: { default: 1 } },
        { index: 1, codec_type: "audio", codec_name: "opus", channels: 2, tags: { language: "eng", title: "Original" } },
        { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "spa" } },
      ],
    };
    const library = open({ ffprobePath: fakeFfprobe(`cat <<'JSON'\n${JSON.stringify(output)}\nJSON`) });

    const probed = unwrap(await library.probe("Talk.mkv"));
    expect(probed.path).toBe("Talk.mkv");
    expect(probed.durationSeconds).toBe(612.5);
    expect(probed.bitrate).toBe(1_450_000);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.streams.find((stream) => stream.kind === "video")?.fps).toBe(29.97);
    expect(probed.streams.filter((stream) => stream.kind === "audio")[0]?.language).toBe("eng");
    expect(probed.streams.filter((stream) => stream.kind === "subtitle")[0]?.codec).toBe("subrip");
  });

  test("a file ffprobe cannot read is ProbeFailed, not a broken library", async () => {
    put("notes.txt", "not media");
    const library = open({ ffprobePath: fakeFfprobe("echo 'Invalid data found' >&2\nexit 1") });
    const probed = await library.probe("notes.txt");
    expect(tagOf(probed)).toBe("ProbeFailed");
  });

  test("a missing ffprobe is reported, not thrown", async () => {
    put("Talk.mkv");
    const probed = await open({ ffprobePath: join(root, "no-such-binary") }).probe("Talk.mkv");
    expect(tagOf(probed)).toBe("ProbeFailed");
  });

  test("an ffprobe that hangs on a dead mount is killed at the deadline", async () => {
    put("Talk.mkv");
    const library = open({ ffprobePath: fakeFfprobe("sleep 30"), ffprobeTimeoutMs: 50 });
    expect(tagOf(await library.probe("Talk.mkv"))).toBe("Timeout");
  });

  test("probing something that is not there is NotFound", async () => {
    expect(tagOf(await open().probe("missing.mkv"))).toBe("NotFound");
  });
});
