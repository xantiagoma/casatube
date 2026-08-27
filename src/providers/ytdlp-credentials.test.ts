/**
 * yt-dlp with credentials — the seam between the store and the command line.
 *
 * A separate file from `ytdlp.test.ts` because the claims are different in
 * kind: that one is about parsing yt-dlp's output, this one is about what ends
 * up in `argv` and what is left on disk afterwards. The spawner is faked, which
 * is the point — the assertion is the argument vector itself.
 *
 * Against a **real** `CredentialStore` on a real database file rather than a
 * stub resolver: the two things worth proving here are that a cookie jar
 * becomes a file yt-dlp is pointed at, and that the file is gone when the run
 * ends, and a fake resolver would have tested the fake.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { CredentialStore } from "../core/credentials";
import { appDbPath, closeDb, openDb, type Db } from "../core/db";
import type { DownloadPlan, ProviderContext } from "../core/types";
import { buildProbeArgs, createYtdlpProvider, redactLine, type Spawner } from "./ytdlp";

let dir: string;
let db: Db;
let store: CredentialStore;

const KEY = "a-long-random-passphrase-for-tests";
const COOKIE_VALUE = "the-session-cookie-nobody-may-see";
const PASSWORD = "hunter2-and-then-some";

function jar(domain = ".youtube.com"): string {
  return `# Netscape HTTP Cookie File\n${domain}\tTRUE\t/\tTRUE\t4102444800\tSID\t${COOKIE_VALUE}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-ytdlp-credentials-"));
  db = openDb({ path: appDbPath(dir) });
  store = new CredentialStore({ db, key: KEY, tempDir: dir, warn: () => {} });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** Records the argv it was handed, and answers with a minimal probe payload. */
function recorder(runs: string[][], onRun?: (args: string[]) => void): Spawner {
  return async ({ args, onStdout }) => {
    runs.push(args);
    onRun?.(args);
    onStdout?.(JSON.stringify({ id: "x", title: "T", webpage_url: "https://x", formats: [] }));
    return { exitCode: 0 };
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("a cookie credential becomes --cookies pointing at a real file, deleted afterwards", async () => {
  await store.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });

  const runs: string[][] = [];
  let contentsDuringRun = "";
  let pathDuringRun = "";
  const provider = createYtdlpProvider({
    binary: "yt-dlp",
    credentials: store,
    spawn: recorder(runs, (args) => {
      // 🔴 Read *while yt-dlp would be running*. Checking after the call would
      // pass against an implementation that never wrote the file at all.
      pathDuringRun = valueAfter(args, "--cookies") ?? "";
      contentsDuringRun = readFileSync(pathDuringRun, "utf8");
    }),
  });

  const probed = await provider.probe("https://youtube.com/watch?v=x", new AbortController().signal);
  expect(Result.isOk(probed)).toBe(true);

  expect(pathDuringRun).not.toBe("");
  expect(contentsDuringRun).toContain(COOKIE_VALUE);
  // Gone once the run is over — a jar per download would otherwise pile up in
  // the temp directory with a live session inside each one.
  expect(await Bun.file(pathDuringRun).exists()).toBe(false);
});

test("a password credential becomes --username and --password", async () => {
  await store.create({
    scope: "example.test",
    secret: { type: "password", username: "santi", password: PASSWORD },
  });

  const runs: string[][] = [];
  const provider = createYtdlpProvider({ credentials: store, spawn: recorder(runs) });
  await provider.probe("https://example.test/v/1", new AbortController().signal);

  const args = runs[0] ?? [];
  expect(valueAfter(args, "--username")).toBe("santi");
  expect(valueAfter(args, "--password")).toBe(PASSWORD);
  expect(args).not.toContain("--cookies");
});

test("the most specific scope decides which jar the command line gets", async () => {
  await store.create({ scope: "*", secret: { type: "cookies", cookies: jar(".anything.test") } });
  await store.create({
    scope: "youtube.com",
    secret: { type: "password", username: "specific", password: PASSWORD },
  });

  const runs: string[][] = [];
  const provider = createYtdlpProvider({ credentials: store, spawn: recorder(runs) });
  await provider.probe("https://youtube.com/watch?v=x", new AbortController().signal);

  const args = runs[0] ?? [];
  expect(valueAfter(args, "--username")).toBe("specific");
  expect(args).not.toContain("--cookies");
});

test("a per-site credential overrides the global COOKIES_FILE", async () => {
  await store.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });

  const runs: string[][] = [];
  const provider = createYtdlpProvider({
    credentials: store,
    cookiesFile: "/data/global-cookies.txt",
    spawn: recorder(runs),
  });
  await provider.probe("https://youtube.com/watch?v=x", new AbortController().signal);

  const args = runs[0] ?? [];
  expect(valueAfter(args, "--cookies")).not.toBe("/data/global-cookies.txt");
  // Exactly one --cookies: two would let yt-dlp pick, and it picks the last.
  expect(args.filter((arg) => arg === "--cookies")).toHaveLength(1);
});

test("with no matching credential the global COOKIES_FILE still applies", async () => {
  await store.create({ scope: "odysee.com", secret: { type: "cookies", cookies: jar(".odysee.com") } });

  const runs: string[][] = [];
  const provider = createYtdlpProvider({
    credentials: store,
    cookiesFile: "/data/global-cookies.txt",
    spawn: recorder(runs),
  });
  await provider.probe("https://youtube.com/watch?v=x", new AbortController().signal);

  expect(valueAfter(runs[0] ?? [], "--cookies")).toBe("/data/global-cookies.txt");
});

test("no resolver at all behaves exactly as before credentials existed", async () => {
  const runs: string[][] = [];
  const provider = createYtdlpProvider({ spawn: recorder(runs) });
  await provider.probe("https://youtube.com/watch?v=x", new AbortController().signal);
  expect(runs[0]).not.toContain("--cookies");
  expect(runs[0]).not.toContain("--username");
});

test("⚠️ --username without --password is never emitted — it would hang on a prompt", () => {
  expect(buildProbeArgs("u", { username: "santi" })).not.toContain("--username");
  expect(buildProbeArgs("u", { password: PASSWORD })).not.toContain("--password");
  expect(buildProbeArgs("u", { username: "santi", password: PASSWORD })).toContain("--username");
});

test("`list` authenticates too — a members-only channel is a listing, not a download", async () => {
  await store.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });
  const runs: string[][] = [];
  const provider = createYtdlpProvider({ credentials: store, spawn: recorder(runs) });
  await provider.list?.("https://youtube.com/@someone", new AbortController().signal);
  expect(runs[0]).toContain("--cookies");
  expect(runs[0]).toContain("--flat-playlist");
});

test("the cookie file survives the whole download and not a moment longer", async () => {
  await store.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });

  let pathDuringRun = "";
  let existedAtEndOfRun = false;
  const provider = createYtdlpProvider({
    credentials: store,
    spawn: async ({ args, onStdout }) => {
      pathDuringRun = valueAfter(args, "--cookies") ?? "";
      // The last thing yt-dlp does is print the output path; the jar has to
      // still be there, because a resumed fragment re-reads it.
      existedAtEndOfRun = await Bun.file(pathDuringRun).exists();
      onStdout?.(`__CASATUBE_FILE__${join(dir, "out.mkv")}`);
      return { exitCode: 0 };
    },
  });

  await Bun.write(join(dir, "out.mkv"), "x");
  const plan: DownloadPlan = {
    url: "https://youtube.com/watch?v=x",
    outputName: "out",
    video: null,
    audio: [],
    subtitles: [],
    languageTags: {},
    subtitleMode: "sidecar",
    sponsorblock: false,
  };
  const ctx: ProviderContext = {
    workDir: dir,
    signal: new AbortController().signal,
    onProgress: () => {},
    log: () => {},
  };

  await provider.fetch(plan, ctx);
  expect(existedAtEndOfRun).toBe(true);
  expect(await Bun.file(pathDuringRun).exists()).toBe(false);
});

test("redactLine scrubs a password out of a log line, and leaves short strings alone", () => {
  expect(redactLine(`ERROR: login failed for ${PASSWORD}`, [PASSWORD])).toBe(
    "ERROR: login failed for ***",
  );
  // A three-character "secret" would turn every line into asterisks.
  expect(redactLine("a normal line about abc", ["abc"])).toBe("a normal line about abc");
  expect(redactLine("nothing to do here", [])).toBe("nothing to do here");
});
