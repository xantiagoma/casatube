/**
 * The one decision in the Vidarro plugin that can be got wrong quietly.
 *
 * 🔴 The page offers a master manifest *and* one per quality. Returning a
 * per-quality one works — and hard-codes the resolution, so the ceiling in
 * Preferences has nothing left to decide and somebody who asked for 480p gets
 * whatever the URL named. Nothing about that failure looks like a failure, which
 * is why it is the part with tests.
 *
 * ⚠️ `readBuiltins` skips files with `.test.` in the name, so this sits beside the
 * plugin without being seeded into `DATA_DIR` as one.
 */
import { describe, expect, test } from "bun:test";

import { masterManifest } from "./vidarro";

const BASE = "https://media.voomly.com/e4bb3c4e-727a-46bb-b962-c14d0be2c25e/178e2327-f438-4510-b77f-8fc26d875203/v2/hls";

/** The shape the real page has: a master, then the ladder, inside a JSON blob. */
const PAGE = `<!DOCTYPE html><html><body><script>window.__DATA__={"hlsUrl":"${BASE}/file.m3u8","qualityOptions":[{"label":"240p","width":240,"height":426,"url":"${BASE}/file240p.m3u8"},{"label":"360p","width":360,"height":640,"url":"${BASE}/file360p.m3u8"},{"label":"480p","width":480,"height":852,"url":"${BASE}/file480p.m3u8"},{"label":"720p","width":720,"height":1280,"url":"${BASE}/file720p.m3u8"}]}</script></body></html>`;

describe("masterManifest", () => {
  test("🔴 picks the master, not a quality — or the ceiling stops meaning anything", () => {
    expect(masterManifest(PAGE)).toBe(`${BASE}/file.m3u8`);
  });

  test("the ladder alone still downloads, and the plugin says which case it was", () => {
    // A page with no master is still worth downloading: one quality beats
    // refusing. The plugin logs the difference so it does not read as the ceiling
    // being ignored.
    const ladderOnly = PAGE.replace(`"hlsUrl":"${BASE}/file.m3u8",`, "");
    const picked = masterManifest(ladderOnly);
    expect(picked).toMatch(/\d{3,4}p\.m3u8$/);
  });

  test("a page with no manifest answers null rather than a guess", () => {
    expect(masterManifest("<html><body>nothing here</body></html>")).toBeNull();
    expect(masterManifest("")).toBeNull();
  });

  test("⚠️ only media.voomly.com is followed", () => {
    // A `matches` entry is a promise about hosts; the extraction must not widen
    // it by pulling any m3u8 that happens to be on the page.
    const elsewhere = `<html><body><script>{"hlsUrl":"https://evil.test/steal/file.m3u8"}</script></body></html>`;
    expect(masterManifest(elsewhere)).toBeNull();
  });

  test("duplicates collapse, so a page that repeats the URL is not a different case", () => {
    const repeated = `${PAGE}${PAGE}`;
    expect(masterManifest(repeated)).toBe(`${BASE}/file.m3u8`);
  });
});
