import { describe, expect, test } from "bun:test";

import { pageNumber, resetsPage } from "./search-params";

describe("paging in the URL", () => {
  test("page 1 stays out of the URL, and nonsense is page 1", () => {
    expect(pageNumber("3")).toBe(3);
    expect(pageNumber(2)).toBe(2);
    expect(pageNumber("1")).toBeUndefined();
    expect(pageNumber("0")).toBeUndefined();
    expect(pageNumber("-4")).toBeUndefined();
    expect(pageNumber("2.5")).toBe(2);
    expect(pageNumber("abc")).toBeUndefined();
    expect(pageNumber(undefined)).toBeUndefined();
  });

  test("🔴 a new filter, search or order starts again at page 1", () => {
    // Otherwise page 7 of the old list becomes "Nothing on page 7" of the new one.
    expect(resetsPage({ q: "blender" })).toBe(true);
    expect(resetsPage({ tab: "completed" })).toBe(true);
    expect(resetsPage({ sort: "size", order: "asc" })).toBe(true);
  });

  test("opening a job, or a tab of its inspector, keeps the page", () => {
    expect(resetsPage({ job: "abc" })).toBe(false);
    expect(resetsPage({ panel: "logs" })).toBe(false);
    expect(resetsPage({ page: 3 })).toBe(false);
  });
});
