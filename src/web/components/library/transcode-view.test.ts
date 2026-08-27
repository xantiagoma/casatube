/**
 * The conversion screen's logic, checked.
 *
 * There is no DOM harness in this repo, so this file is the only thing that can
 * reach any of it — which is the reason the ordering, the queue position and
 * the wording of a partial batch are pure functions rather than expressions
 * inside a component.
 *
 * 🔴 The three claims the UI makes are the three worth testing: that a waiting
 * row can say *how many are in front of it* (the readable form of
 * `concurrency: 1`), that a running job with no measurable duration shows as
 * working rather than as 0%, and that a batch which half-failed reports **both**
 * halves.
 */
import { describe, expect, test } from "bun:test";

import type { TranscodeRow } from "../../../core/transcode";
import {
  activeTranscodes,
  concurrencyLine,
  fileNameOf,
  hasActiveTranscode,
  isCancellable,
  queuePositionLabel,
  sortTranscodes,
  summariseOutcome,
  transcodeLook,
  transcodeProgress,
  transcodesAhead,
  transcodesForPath,
} from "./transcode-view";

function row(over: Partial<TranscodeRow> & { id: string }): TranscodeRow {
  return {
    sourcePath: `Videos/${over.id}.mkv`,
    outputPath: `Videos/${over.id} (TV).mp4`,
    preset: "tv",
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: 2,
    notBefore: null,
    replaceOriginal: false,
    durationSeconds: 600,
    sourceBytes: 1_000,
    outputBytes: null,
    error: null,
    log: [],
    createdAt: "2026-08-27T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-08-27T10:00:00.000Z",
    ...over,
  };
}

describe("transcodeLook", () => {
  test("queued reads as waiting, not as queued", () => {
    // The wording is the point: five rows saying "Queued" look stalled.
    expect(transcodeLook("queued").label).toBe("Waiting");
    expect(transcodeLook("running").tone).toBe("busy");
    expect(transcodeLook("failed").tone).toBe("danger");
  });

  test("a status this build has never seen still renders", () => {
    // `status` is a plain text column, so this is reachable from a server that
    // is one version ahead — and it must not render `undefined`.
    expect(transcodeLook("verifying")).toEqual({ label: "verifying", tone: "idle" });
  });
});

describe("sortTranscodes", () => {
  test("running first, then waiting, then what is over", () => {
    const rows = sortTranscodes([
      row({ id: "done", status: "done", createdAt: "2026-08-27T09:00:00.000Z" }),
      row({ id: "wait", status: "queued", createdAt: "2026-08-27T11:00:00.000Z" }),
      row({ id: "run", status: "running", createdAt: "2026-08-27T08:00:00.000Z" }),
    ]);
    expect(rows.map((one) => one.id)).toEqual(["run", "wait", "done"]);
  });

  test("waiting rows are oldest-first, because that is the order they will run in", () => {
    const rows = sortTranscodes([
      row({ id: "second", createdAt: "2026-08-27T11:00:00.000Z" }),
      row({ id: "first", createdAt: "2026-08-27T10:00:00.000Z" }),
    ]);
    expect(rows.map((one) => one.id)).toEqual(["first", "second"]);
  });

  test("finished rows are newest-first, because the newest is the one being looked for", () => {
    const rows = sortTranscodes([
      row({ id: "old", status: "done", createdAt: "2026-08-27T10:00:00.000Z" }),
      row({ id: "new", status: "done", createdAt: "2026-08-27T12:00:00.000Z" }),
    ]);
    expect(rows.map((one) => one.id)).toEqual(["new", "old"]);
  });

  test("the order is total, so a poll cannot shuffle two rows of the same instant", () => {
    const same = "2026-08-27T10:00:00.000Z";
    const first = sortTranscodes([row({ id: "b", createdAt: same }), row({ id: "a", createdAt: same })]);
    const second = sortTranscodes([row({ id: "a", createdAt: same }), row({ id: "b", createdAt: same })]);
    expect(first.map((one) => one.id)).toEqual(second.map((one) => one.id));
  });

  test("the input array is not mutated", () => {
    const input = [row({ id: "b", status: "done" }), row({ id: "a", status: "running" })];
    sortTranscodes(input);
    expect(input.map((one) => one.id)).toEqual(["b", "a"]);
  });
});

describe("transcodesAhead", () => {
  const jobs = [
    row({ id: "running", status: "running", createdAt: "2026-08-27T09:00:00.000Z" }),
    row({ id: "first", createdAt: "2026-08-27T10:00:00.000Z" }),
    row({ id: "second", createdAt: "2026-08-27T11:00:00.000Z" }),
    row({ id: "third", createdAt: "2026-08-27T12:00:00.000Z" }),
  ];

  test("counts the running job and every earlier waiting one", () => {
    expect(transcodesAhead(jobs, "first")).toBe(1);
    expect(transcodesAhead(jobs, "second")).toBe(2);
    expect(transcodesAhead(jobs, "third")).toBe(3);
  });

  test("a finished or failed row is in nobody's way", () => {
    const withNoise = [
      ...jobs,
      row({ id: "old-done", status: "done", createdAt: "2026-08-27T08:00:00.000Z" }),
      row({ id: "old-failed", status: "failed", createdAt: "2026-08-27T08:30:00.000Z" }),
      row({ id: "old-cancelled", status: "cancelled", createdAt: "2026-08-27T08:45:00.000Z" }),
    ];
    expect(transcodesAhead(withNoise, "first")).toBe(1);
  });

  test("a row that is not waiting has nothing ahead of it", () => {
    expect(transcodesAhead(jobs, "running")).toBe(0);
    expect(transcodesAhead(jobs, "nobody")).toBe(0);
  });
});

describe("queuePositionLabel", () => {
  test("says what is in front, in words", () => {
    expect(queuePositionLabel(0)).toBe("Next in line");
    expect(queuePositionLabel(1)).toBe("1 conversion ahead of it");
    expect(queuePositionLabel(4)).toBe("4 conversions ahead of it");
  });
});

describe("concurrencyLine", () => {
  test("says nothing when nothing is queued or running", () => {
    expect(concurrencyLine([row({ id: "a", status: "done" })], 1)).toBeNull();
    expect(concurrencyLine([], 1)).toBeNull();
  });

  test("explains the waiting rows rather than leaving them looking stuck", () => {
    const jobs = [
      row({ id: "run", status: "running" }),
      row({ id: "a" }),
      row({ id: "b" }),
    ];
    const line = concurrencyLine(jobs, 1);
    expect(line).toContain("One conversion runs at a time");
    expect(line).toContain("the other 2 are waiting");
    expect(line).toContain("not stuck");
  });

  test("one waiting row is singular", () => {
    expect(concurrencyLine([row({ id: "run", status: "running" }), row({ id: "a" })], 1)).toContain(
      "the other one is waiting its turn",
    );
  });

  test("the running job on its own has nothing behind it", () => {
    expect(concurrencyLine([row({ id: "run", status: "running" })], 1)).toBe(
      "One conversion runs at a time. Nothing else is waiting.",
    );
  });

  test("the number comes from the server, so a different one is worded too", () => {
    // `concurrency` is 1 today. The sentence still has to survive it not being.
    expect(concurrencyLine([row({ id: "run", status: "running" })], 3)).toContain("Up to 3 conversions run at a time");
  });
});

describe("transcodeProgress", () => {
  test("a running job with a known duration reports its percentage", () => {
    expect(transcodeProgress(row({ id: "a", status: "running", progress: 42 }))).toEqual({
      percent: 42,
      indeterminate: false,
    });
  });

  test("a running job with no measurable duration is working, not at zero", () => {
    // 🔴 `core/transcode.ts` leaves `progress` at 0 for the whole encode when
    // the source has no duration. A bar at 0% says nothing is happening about
    // a job that is using the entire machine.
    const bar = transcodeProgress(row({ id: "a", status: "running", durationSeconds: null, progress: 0 }));
    expect(bar.indeterminate).toBe(true);
  });

  test("the first seconds of every job are indeterminate too", () => {
    expect(transcodeProgress(row({ id: "a", status: "running", progress: 0 })).indeterminate).toBe(true);
  });

  test("done is 100, and only done", () => {
    // The runner caps a live job at 99: 100 belongs to the file being closed.
    expect(transcodeProgress(row({ id: "a", status: "done", progress: 100 })).percent).toBe(100);
    expect(transcodeProgress(row({ id: "b", status: "running", progress: 99 })).percent).toBe(99);
    expect(transcodeProgress(row({ id: "c", status: "cancelled", progress: 37 }))).toEqual({
      percent: 37,
      indeterminate: false,
    });
  });
});

describe("what belongs to one file", () => {
  const jobs = [
    row({ id: "a", sourcePath: "Videos/Film.mkv", status: "done" }),
    row({ id: "b", sourcePath: "Videos/Film.mkv", status: "running" }),
    row({ id: "c", sourcePath: "Videos/Other.mkv" }),
  ];

  test("transcodesForPath picks the file's own rows, in screen order", () => {
    expect(transcodesForPath(jobs, "Videos/Film.mkv").map((one) => one.id)).toEqual(["b", "a"]);
    expect(transcodesForPath(jobs, "Videos/Nothing.mkv")).toEqual([]);
  });

  test("hasActiveTranscode is what disables the button before the server refuses", () => {
    expect(hasActiveTranscode(jobs, "Videos/Film.mkv")).toBe(true);
    expect(hasActiveTranscode(jobs, "Videos/Other.mkv")).toBe(true);
    expect(hasActiveTranscode([jobs[0]!], "Videos/Film.mkv")).toBe(false);
  });

  test("active means queued or running, and cancellable means the same", () => {
    expect(activeTranscodes(jobs).map((one) => one.id)).toEqual(["b", "c"]);
    expect(isCancellable(row({ id: "x", status: "running" }))).toBe(true);
    expect(isCancellable(row({ id: "x", status: "queued" }))).toBe(true);
    expect(isCancellable(row({ id: "x", status: "done" }))).toBe(false);
  });

  test("fileNameOf drops the folder", () => {
    expect(fileNameOf("Videos/Shows/Film (TV).mp4")).toBe("Film (TV).mp4");
    expect(fileNameOf("Film.mp4")).toBe("Film.mp4");
  });
});

describe("summariseOutcome", () => {
  test("a clean batch counts what was queued", () => {
    expect(summariseOutcome({ queued: [1], rejected: [] }).headline).toBe("Queued for conversion.");
    expect(summariseOutcome({ queued: [1, 2, 3], rejected: [] }).headline).toBe("3 files queued for conversion.");
  });

  test("a half-failed batch names both halves", () => {
    // 🔴 Partial success is the normal answer over a real folder. A headline
    // that reported only the successes is how a file silently does not convert.
    const summary = summariseOutcome({ queued: [1, 2], rejected: [3] });
    expect(summary.headline).toContain("2 files queued");
    expect(summary.headline).toContain("1 could not be");
  });

  test("nothing queued is said plainly", () => {
    expect(summariseOutcome({ queued: [], rejected: [1, 2] }).headline).toBe(
      "Nothing was queued — 2 files could not be.",
    );
    expect(summariseOutcome({ queued: [], rejected: [] }).headline).toBe("Nothing was queued.");
  });
});
