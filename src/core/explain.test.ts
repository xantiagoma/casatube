import { describe, expect, test } from "bun:test";

import { explainFailure } from "./explain";

describe("explainFailure", () => {
  test("🔴 the urllib DNS failure the demo instance showed becomes a sentence", () => {
    // Verbatim from a failed Analyze, raw text and all.
    const raw =
      "Unable to download webpage: <urlopen error [Errno -2] Name or service not known> " +
      "(caused by TransportError('<urlopen error [Errno -2] Name or service not known>'))";
    const said = explainFailure(raw, "https://www.youtube.com/watch?v=x");
    expect(said).toContain("Could not look up youtube.com");
    expect(said).not.toContain("Errno");
  });

  test("each well-understood kind names the site, without the www", () => {
    const url = "https://www.vimeo.com/1";
    expect(explainFailure("[Errno 111] Connection refused", url)).toBe("vimeo.com refused the connection.");
    expect(explainFailure("Read timed out. (read timeout=20.0)", url)).toContain("vimeo.com did not answer in time");
    expect(explainFailure("HTTP Error 404: Not Found", url)).toContain("(404)");
    expect(explainFailure("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", url)).toContain(
      "secure connection to vimeo.com",
    );
  });

  test("anything else is left alone — a wrong explanation is worse than none", () => {
    expect(explainFailure("Requested format is not available")).toBeNull();
    expect(explainFailure("Video unavailable. This video is private")).toBeNull();
  });

  test("a URL that will not parse still gets a sentence", () => {
    expect(explainFailure("Network is unreachable", "not a url")).toBe(
      "The server running CasaTube cannot reach the internet right now.",
    );
    expect(explainFailure("[Errno -3] Temporary failure in name resolution")).toContain("Could not look up the site.");
    expect(explainFailure("[Errno 111] Connection refused")).toBe("The site refused the connection.");
  });
});
