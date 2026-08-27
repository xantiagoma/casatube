/**
 * What the header indicator decides, without a browser.
 *
 * The component is a rendering of this; the rules are here, so this is where
 * they can be checked. The one that matters most is the negative: **queued is
 * not running**, because that is the number a badge is most likely to get wrong
 * and the mistake is invisible until the queue is long.
 */
import { describe, expect, test } from "bun:test";

import type { Job, JobStatus, Stage, StageName } from "../../../core/types";
import { summariseActivity } from "./active-downloads";

function job(over: Partial<Job> & { id: string; status: JobStatus }): Job {
  return {
    url: `https://example.test/${over.id}`,
    provider: "test",
    destination: "",
    title: over.id,
    stages: [],
    priority: "normal",
    attempts: 0,
    maxAttempts: 3,
    paused: false,
    claimedBy: null,
    leaseUntil: null,
    notBefore: null,
    progress: 0,
    totalBytes: null,
    doneBytes: null,
    speed: null,
    eta: null,
    thumbnail: null,
    duration: null,
    source: null,
    plan: null,
    preferences: {
      originalOnly: true,
      audioLanguages: [],
      subtitleLanguages: ["en"],
      maxResolution: 1080,
      videoCodec: "auto",
      sponsorblock: true,
      embedSubtitles: false,
    },
    fingerprint: "f",
    log: [],
    error: null,
    outputFile: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...over,
  } as Job;
}

const running = (name: StageName): Stage[] => [{ name, status: "running" }];

describe("what counts as running", () => {
  test("nothing at all reads as nothing, so the header draws nothing", () => {
    expect(summariseActivity([]).count).toBe(0);
    expect(summariseActivity(undefined).count).toBe(0);
  });

  test("🔴 a queue with nothing being worked on is not activity", () => {
    const summary = summariseActivity([
      job({ id: "a", status: "queued" }),
      job({ id: "b", status: "queued" }),
      job({ id: "c", status: "done" }),
      job({ id: "d", status: "failed" }),
    ]);

    expect(summary.count).toBe(0);
    // The waiting ones are still reported — as waiting.
    expect(summary.queued).toBe(2);
  });

  test("the four working statuses count, and the terminal ones do not", () => {
    const summary = summariseActivity([
      job({ id: "1", status: "analyzing" }),
      job({ id: "2", status: "downloading" }),
      job({ id: "3", status: "processing" }),
      job({ id: "4", status: "moving" }),
      job({ id: "5", status: "done" }),
      job({ id: "6", status: "cancelled" }),
      job({ id: "7", status: "waiting-for-destination" }),
    ]);

    expect(summary.running.map((view) => view.id)).toEqual(["1", "2", "3", "4"]);
  });

  test("a paused job is not waiting for a slot", () => {
    // It is waiting for a person. Counting it as queued would make the header
    // promise work that will never start on its own.
    expect(summariseActivity([job({ id: "a", status: "queued", paused: true })]).queued).toBe(0);
  });
});

describe("the stage, in a few words", () => {
  test("comes from the pipeline record, which is finer than the status", () => {
    // ⚠️ Both of these are `processing`. One word for two very different
    // things is exactly what PLAN §6 says a status cannot express.
    const merging = summariseActivity([job({ id: "a", status: "processing", stages: running("postprocess") })]);
    const tagging = summariseActivity([job({ id: "b", status: "processing", stages: running("metadata") })]);

    expect(merging.running[0]!.stage).toBe("Merging");
    expect(tagging.running[0]!.stage).toBe("Tagging");
  });

  test("falls back to the status when no stage is marked running", () => {
    const summary = summariseActivity([job({ id: "a", status: "downloading", stages: [] })]);
    expect(summary.running[0]!.stage).toBe("Downloading");
  });
});

describe("the number on the trigger", () => {
  test("one job shows its percentage", () => {
    const summary = summariseActivity([job({ id: "a", status: "downloading", progress: 42 })]);
    expect(summary.soloPercent).toBe(42);
    expect(summary.count).toBe(1);
  });

  test("⚠️ a job that has reported nothing yet has no percentage to show", () => {
    // Not 0%. "It has downloaded none of it" and "nobody has measured it yet"
    // are different states, and printing a number for the second is the same
    // failure as a bar at 100% during a merge.
    const summary = summariseActivity([job({ id: "a", status: "analyzing", progress: 0 })]);
    expect(summary.running[0]!.indeterminate).toBe(true);
    expect(summary.soloPercent).toBeNull();
  });

  test("two or more jobs show a count instead", () => {
    const summary = summariseActivity([
      job({ id: "a", status: "downloading", progress: 10 }),
      job({ id: "b", status: "downloading", progress: 90 }),
    ]);
    expect(summary.soloPercent).toBeNull();
    expect(summary.count).toBe(2);
  });
});

describe("order", () => {
  test("oldest first, and it does not move as the percentages change", () => {
    const older = job({ id: "z", status: "downloading", progress: 5, createdAt: "2026-08-27T09:00:00.000Z" });
    const newer = job({ id: "a", status: "downloading", progress: 95, createdAt: "2026-08-27T10:00:00.000Z" });

    // Given in either order, and with the newer one far ahead, the answer is
    // the same list.
    expect(summariseActivity([newer, older]).running.map((v) => v.id)).toEqual(["z", "a"]);
    expect(summariseActivity([older, newer]).running.map((v) => v.id)).toEqual(["z", "a"]);
  });
});
