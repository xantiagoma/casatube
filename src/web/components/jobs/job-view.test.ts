import { describe, expect, test } from "bun:test";

import type { Job } from "../../../core/types";
import { formatLabel, readableUrl } from "./job-view";

describe("readableUrl", () => {
  test("a job with no title yet reads as the link a person would say", () => {
    expect(readableUrl("https://www.youtube.com/watch?v=R6MlUcmOul8")).toBe("youtube.com/watch?v=R6MlUcmOul8");
    expect(readableUrl("http://vimeo.com/123/")).toBe("vimeo.com/123");
    expect(readableUrl("https://t.me/c/1/2")).toBe("t.me/c/1/2");
  });

  test("something that is not a URL is left as it is", () => {
    expect(readableUrl("not a url")).toBe("not a url");
  });
});

describe("formatLabel", () => {
  test("🔴 a cinema-shaped file is labelled like the form labelled it", () => {
    // The Format column said "800p · VP09" for a download the form called 1080p.
    const job = { plan: { url: "x", video: { id: "v", width: 1920, height: 800, codec: "vp09.00" }, audio: [], subtitles: [] } } as unknown as Job;
    expect(formatLabel(job)).toBe("1080p · VP09");
  });
});
