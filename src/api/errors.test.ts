import { describe, expect, test } from "bun:test";

import { ProbeFailed } from "../core/errors";
import { toApiError } from "./errors";

describe("toApiError", () => {
  test("🔴 a network failure reads as a sentence, and the raw text rides along", () => {
    const raw = "Unable to download webpage: <urlopen error [Errno -2] Name or service not known>";
    const body = toApiError(new ProbeFailed({ url: "https://www.youtube.com/watch?v=x", detail: raw }));
    expect(body.message).toContain("Could not look up youtube.com");
    expect(body.message).not.toContain("Errno");
    expect(body.detail).toBe(raw);
  });

  test("a failure with no plain reading keeps its old message and carries no detail", () => {
    const body = toApiError(new ProbeFailed({ url: "https://x.test/", detail: "Requested format is not available" }));
    expect(body.message).toBe("Could not read this video's details: Requested format is not available");
    expect(body.detail).toBeUndefined();
  });
});
