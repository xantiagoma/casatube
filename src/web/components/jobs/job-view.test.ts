import { describe, expect, test } from "bun:test";

import { readableUrl } from "./job-view";

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
