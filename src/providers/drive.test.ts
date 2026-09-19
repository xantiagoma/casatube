/**
 * The Drive provider, driven by an injected `fetch`.
 *
 * 🔴 The HTML in `WARNING_PAGE` is **real** — captured from Drive on 2026-09-19
 * while diagnosing the failure this provider exists for. A hand-written
 * approximation would test the parser against my idea of the page rather than
 * against the page, and the whole risk here is that Google's markup is not what
 * we assume.
 *
 * Everything runs with no network. What it cannot prove is that Drive still
 * serves this shape tomorrow — that is what a real download checks, and the
 * provider's header says so.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import type { DownloadPlan, ProviderContext } from "../core/types";
import { selectVideoFormat } from "../core/selection";
import {
  buildInfo,
  confirmTarget,
  createDriveProvider,
  extensionFor,
  filenameFrom,
  parseDriveId,
  titleFrom,
} from "./drive";

const ID = "1kYCt9khTzxrNzfGAaWJ29sKLGH82Qfpb";

/** Trimmed from the real page, form intact. */
const WARNING_PAGE = `<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="submit" id="uc-download-link" value="Download anyway"/><input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="1bfc8426-283e-4285-96fe-c066fb1704cc"></form>
</body></html>`;

const SIGN_IN_PAGE = `<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head>
<body>You need permission to access this item. Request access or sign in.</body></html>`;

describe("parseDriveId", () => {
  test("every shape a person actually pastes", () => {
    for (const url of [
      `https://drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/preview`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/uc?id=${ID}&export=download`,
      `https://docs.google.com/uc?id=${ID}`,
      `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    ]) {
      expect(parseDriveId(url)).toBe(ID);
    }
  });

  test("🔴 a folder is not a file, and is left to whatever can list it", () => {
    // Claiming it would fail on something a person could reasonably paste — and
    // a provider that claims a URL it cannot serve makes the fallback
    // unreachable for it.
    expect(parseDriveId(`https://drive.google.com/drive/folders/${ID}`)).toBeNull();
    expect(parseDriveId("https://drive.google.com/drive/my-drive")).toBeNull();
  });

  test("an id is checked for shape, not accepted because it is there", () => {
    expect(parseDriveId("https://drive.google.com/file/d/short/view")).toBeNull();
    expect(parseDriveId("https://drive.google.com/open?id=abc")).toBeNull();
    expect(parseDriveId("https://drive.google.com/file/d//view")).toBeNull();
    expect(parseDriveId("https://example.com/file/d/" + ID + "/view")).toBeNull();
    expect(parseDriveId("not a url")).toBeNull();
  });
});

describe("confirmTarget", () => {
  test("🔴 builds the URL from every hidden input, against the real page", () => {
    const target = confirmTarget(WARNING_PAGE);
    expect(target).not.toBeNull();
    const url = new URL(target!);
    expect(url.origin + url.pathname).toBe("https://drive.usercontent.google.com/download");
    expect(url.searchParams.get("id")).toBe(ID);
    expect(url.searchParams.get("confirm")).toBe("t");
    expect(url.searchParams.get("uuid")).toBe("1bfc8426-283e-4285-96fe-c066fb1704cc");
    expect(url.searchParams.get("export")).toBe("download");
  });

  test("🔴 a renamed token still travels, because nothing looks for `confirm`", () => {
    // The token's name is Google's to change. A parser that knows only today's
    // name fails on a page that still contains everything it needs.
    const renamed = WARNING_PAGE.replace('name="confirm"', 'name="acknowledge"').replace(
      'name="uuid"',
      'name="nonce"',
    );
    const url = new URL(confirmTarget(renamed)!);
    expect(url.searchParams.get("acknowledge")).toBe("t");
    expect(url.searchParams.get("nonce")).toBe("1bfc8426-283e-4285-96fe-c066fb1704cc");
  });

  test("no form means null, which is how a sign-in page is told apart", () => {
    expect(confirmTarget(SIGN_IN_PAGE)).toBeNull();
    expect(confirmTarget("<html><body>nothing here</body></html>")).toBeNull();
  });

  test("a form with no id is refused rather than followed", () => {
    const useless = '<form action="https://drive.usercontent.google.com/download"><input type="hidden" name="export" value="download"></form>';
    expect(confirmTarget(useless)).toBeNull();
  });

  test("⚠️ an action that is not https is not followed", () => {
    const sneaky = `<form action="http://evil.test/x"><input type="hidden" name="id" value="${ID}"></form>`;
    expect(confirmTarget(sneaky)).toBeNull();
  });

  test("entities in the action are decoded", () => {
    const encoded = `<form action="https://drive.usercontent.google.com/download?a=1&amp;b=2"><input type="hidden" name="id" value="${ID}"></form>`;
    expect(confirmTarget(encoded)).toContain("a=1&b=2");
  });
});

describe("naming", () => {
  test("the filename comes out of content-disposition, quoted or not", () => {
    expect(filenameFrom('attachment; filename="Captured by My Rival Backup.mp4"')).toBe(
      "Captured by My Rival Backup.mp4",
    );
    expect(filenameFrom("attachment; filename=plain.mkv")).toBe("plain.mkv");
    expect(filenameFrom("attachment; filename*=UTF-8''Cap%C3%ADtulo%201.mp4")).toBe("Capítulo 1.mp4");
    expect(filenameFrom(null)).toBeUndefined();
  });

  test("the title is the filename without its extension", () => {
    expect(titleFrom({ id: ID, url: "x", filename: "Captured by My Rival Backup.mp4" })).toBe(
      "Captured by My Rival Backup",
    );
    // And something recognisable when Drive states no name at all.
    expect(titleFrom({ id: ID, url: "x" })).toBe(`Drive ${ID.slice(0, 8)}`);
  });

  test("🔴 a subtype that is not an extension is mapped, not used raw", () => {
    // Same failure the Telegram provider avoids: a container named after a
    // format it is not, which everything downstream then believes.
    expect(extensionFor({ id: ID, url: "x", filename: "a.mkv" })).toBe("mkv");
    expect(extensionFor({ id: ID, url: "x", mimeType: "video/x-matroska" })).toBe("mkv");
    expect(extensionFor({ id: ID, url: "x", mimeType: "video/mp4" })).toBe("mp4");
    expect(extensionFor({ id: ID, url: "x", mimeType: "video/quicktime" })).toBe("mov");
    expect(extensionFor({ id: ID, url: "x" })).toBe("mp4");
  });
});

describe("buildInfo", () => {
  test("🔴 one format with no dimensions, so no ceiling can refuse it", () => {
    // Drive states no duration and no resolution, and reading them would mean
    // downloading the file — the thing a probe exists to avoid. A format with no
    // dimensions is `selectVideoFormat`'s last-resort pool, which is the right
    // answer for a source that has exactly one file.
    const info = buildInfo({ id: ID, url: "x", size: 10, filename: "a.mp4" });
    expect(info.videoFormats).toEqual([{ id: "drive" }]);
    expect(info.audioTracks).toEqual([]);
    expect(info.duration).toBeUndefined();

    for (const ceiling of [144, 720, 1080, 4320]) {
      expect(selectVideoFormat(info.videoFormats, ceiling, "auto")?.id).toBe("drive");
    }
  });
});

// --- The provider, with fetch injected ---------------------------------------

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "casatube-drive-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function context(progress: { doneBytes?: number; percent?: number }[] = []): ProviderContext {
  return {
    workDir: work,
    signal: new AbortController().signal,
    onProgress: (update) => progress.push(update),
    log: () => {},
  };
}

function plan(outputName = "A file"): DownloadPlan {
  return {
    url: `https://drive.google.com/file/d/${ID}/view`,
    video: { id: "drive" },
    audio: [],
    subtitles: [],
    languageTags: {},
    sponsorblock: false,
    subtitleMode: "sidecar",
    outputName,
  } as DownloadPlan;
}

/** The two-step answer Drive really gives for a large file. */
function driveFetch(options: { body?: string; statedTotal?: number; page?: string } = {}) {
  // ⚠️ A string rather than a Uint8Array: the bodies only need a *length* here,
  // and Bun types `BodyInit` strictly enough that a typed array is a fight for
  // nothing.
  const body = options.body ?? "x".repeat(1024);
  const total = options.statedTotal ?? body.length;
  const seen: string[] = [];

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const range = new Headers(init?.headers).get("range");

    if (!url.includes("confirm=") && !url.includes("acknowledge=")) {
      return new Response(options.page ?? WARNING_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (range !== null) {
      return new Response(body.slice(0, 1), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes 0-0/${total}`,
          "content-disposition": 'attachment; filename="Captured by My Rival Backup.mp4"',
        },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(body.length) },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetcher, seen };
}

describe("probe", () => {
  test("follows the warning page and reports the file it found", async () => {
    const { fetcher, seen } = driveFetch();
    const provider = createDriveProvider({ fetch: fetcher });

    const info = await provider.probe(plan().url, new AbortController().signal);
    expect(Result.isOk(info)).toBe(true);
    if (!Result.isOk(info)) return;
    expect(info.value.title).toBe("Captured by My Rival Backup");
    expect(info.value.source).toBe("drive");
    // ⚠️ Two requests and not one byte of video: the page, then one byte.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("confirm=t");
  });

  test("a small file answers with bytes straight away, and that is not an error", async () => {
    const direct = (async () =>
      new Response("0123456789abcdef", {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "16",
          "content-disposition": 'attachment; filename="small.mp4"',
        },
      })) as unknown as typeof globalThis.fetch;

    const info = await createDriveProvider({ fetch: direct }).probe(plan().url, new AbortController().signal);
    expect(Result.isOk(info) && info.value.title).toBe("small");
  });

  test("🔴 a private file is AuthRequired, naming the credential that fixes it", async () => {
    // Not ProbeFailed: "add cookies for drive.google.com" is a thing somebody can
    // do, and the generic message for this error talks about YouTube cookies.
    const { fetcher } = driveFetch({ page: SIGN_IN_PAGE });
    const info = await createDriveProvider({ fetch: fetcher }).probe(plan().url, new AbortController().signal);

    expect(Result.isError(info) && info.error._tag).toBe("AuthRequired");
    if (Result.isError(info)) {
      const detail = (info.error as { detail?: string }).detail ?? "";
      expect(detail).toContain("drive.google.com");
      expect(detail).toContain("cookies");
    }
  });

  test("a page that is neither is reported with its title rather than as a mystery", async () => {
    const { fetcher } = driveFetch({ page: "<html><head><title>Error 404 (Not Found)</title></head></html>" });
    const info = await createDriveProvider({ fetch: fetcher }).probe(plan().url, new AbortController().signal);
    expect(Result.isError(info) && info.error._tag).toBe("ProbeFailed");
    if (Result.isError(info)) {
      expect((info.error as { detail: string }).detail).toContain("Not Found");
    }
  });
});

describe("fetch", () => {
  test("writes the file, named from the plan and extensioned from Drive", async () => {
    const { fetcher } = driveFetch();
    const progress: { doneBytes?: number; percent?: number }[] = [];

    const got = await createDriveProvider({ fetch: fetcher }).fetch(plan(), context(progress));
    expect(Result.isOk(got)).toBe(true);
    if (!Result.isOk(got)) return;
    expect(got.value.file).toBe(join(work, "A file.mp4"));
    expect(Bun.file(got.value.file).size).toBe(1024);
    expect(progress.at(-1)?.percent).toBe(100);
  });

  test("🔴 a truncated download fails instead of filing half a video away", async () => {
    // The ordinary failure here: a reset connection ends the stream and
    // everything looks finished. Comparing what was written against the stated
    // total is the only thing that tells a whole file from half of one — and half
    // a file that the move stage happily files away is worse than a failure.
    const { fetcher } = driveFetch({ body: "y".repeat(500), statedTotal: 5_000 });

    const got = await createDriveProvider({ fetch: fetcher }).fetch(plan(), context());
    expect(Result.isError(got) && got.error._tag).toBe("FetchFailed");
    if (Result.isError(got)) {
      expect((got.error as { detail: string }).detail).toContain("500 of 5000");
    }
  });

  test("a private file fails as AuthRequired here too, not as a download problem", async () => {
    const { fetcher } = driveFetch({ page: SIGN_IN_PAGE });
    const got = await createDriveProvider({ fetch: fetcher }).fetch(plan(), context());
    expect(Result.isError(got) && got.error._tag).toBe("AuthRequired");
  });
});

describe("supports", () => {
  test("Drive files, and nothing else", () => {
    const provider = createDriveProvider();
    expect(provider.supports(`https://drive.google.com/file/d/${ID}/view`)).toBe(true);
    expect(provider.supports(`https://drive.google.com/drive/folders/${ID}`)).toBe(false);
    expect(provider.supports("https://youtube.com/watch?v=x")).toBe(false);
  });
});
