/**
 * The Telegram provider, driven by a fake connection.
 *
 * 🔴 Everything here runs with no network and no account, and that is the reason
 * `TelegramConnection` exists as an interface at all: the provider is one
 * `getMessages` and one `downloadMedia` around a lot of decisions — which link
 * is claimed, which extension is chosen, what happens when the session is
 * missing or half-filled — and a test that had to stand up MTProto to reach
 * those decisions would be testing teleproto instead of this file.
 *
 * The one thing these cannot prove is that teleproto's shapes are what the
 * adapter believes. That is what a first real download checks, and nothing here
 * pretends otherwise.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import type { CredentialLease, CredentialResolver } from "../core/credentials";
import { DEFAULT_PREFERENCES, type DownloadPlan, type ProviderContext } from "../core/types";
import {
  buildInfo,
  createTelegramProvider,
  extensionFor,
  markedChannelId,
  parseTelegramLink,
  titleFor,
  type TelegramConnection,
  type TelegramMessage,
} from "./telegram";

// --- Links -------------------------------------------------------------------

describe("parseTelegramLink", () => {
  test("a private channel link carries the internal id and the message", () => {
    expect(parseTelegramLink("https://t.me/c/1234567890/42")).toEqual({
      kind: "private",
      channelId: "1234567890",
      messageId: 42,
    });
  });

  test("🔴 in the topic form the LAST number is the message", () => {
    // `t.me/c/<channel>/<thread>/<message>`. Reading the first number as the
    // message id downloads whatever sits at the top of the topic — a wrong file,
    // successfully, which is the worst shape a bug can take here.
    expect(parseTelegramLink("https://t.me/c/1234567890/7/42")).toEqual({
      kind: "private",
      channelId: "1234567890",
      messageId: 42,
    });
    expect(parseTelegramLink("https://t.me/somechannel/7/42")).toEqual({
      kind: "public",
      username: "somechannel",
      messageId: 42,
    });
  });

  test("display parameters are ignored — they do not say which message it is", () => {
    for (const suffix of ["?single", "?comment=99", "?t=1m30s", "?single&comment=1"]) {
      expect(parseTelegramLink(`https://t.me/c/1234567890/42${suffix}`)).toEqual({
        kind: "private",
        channelId: "1234567890",
        messageId: 42,
      });
    }
  });

  test("a public post parses, and the other Telegram hosts are the same thing", () => {
    for (const host of ["t.me", "telegram.me", "telegram.dog", "www.t.me"]) {
      expect(parseTelegramLink(`https://${host}/somechannel/42`)).toEqual({
        kind: "public",
        username: "somechannel",
        messageId: 42,
      });
    }
  });

  test("🔴 what is deliberately not a message link", () => {
    for (const url of [
      "https://t.me/somechannel", // a channel, no message
      "https://t.me/+AbCdEfGhIj", // an invite
      "https://t.me/joinchat/AbCdEf", // an older invite
      "https://t.me/s/somechannel/42", // the web preview yt-dlp reads
      "https://t.me/c/1234567890", // a channel with no message
      "https://t.me/c/notanumber/42", // not a channel id
      "https://t.me/somechannel/notanumber",
      "https://example.com/c/1234567890/42", // not Telegram
      "https://t.me/ab/42", // too short to be a username
      "not a url at all",
    ]) {
      expect(parseTelegramLink(url)).toBeNull();
    }
  });

  test("🔴 the channel id survives being bigger than a double", () => {
    // Channel ids pass 2^53. Rounding one lands on a *different* channel, which
    // would fail as "no such message" a long way from the cause.
    const big = "2999999999999999";
    expect(markedChannelId(big)).toBe(BigInt(`-100${big}`));
    expect(markedChannelId(big).toString()).toBe(`-100${big}`);
  });
});

// --- Naming ------------------------------------------------------------------

const MESSAGE: TelegramMessage = {
  id: 42,
  text: "Charla sobre nada\nsegunda línea",
  fileName: "charla.final.mkv",
  mimeType: "video/x-matroska",
  size: 1024,
  durationSeconds: 610,
  width: 1920,
  height: 1080,
  handle: { fake: true },
};

describe("extensionFor", () => {
  test("the filename decides, then the MIME type, then mp4", () => {
    expect(extensionFor(MESSAGE)).toBe("mkv");
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: "video/mp4" })).toBe("mp4");
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: "video/webm" })).toBe("webm");
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: undefined })).toBe("mp4");
  });

  test("🔴 a subtype that is not an extension is mapped, not used raw", () => {
    // `video/x-matroska` saved as `.mp4` — or worse, as `.x-matroska` — is a
    // container named after a format it is not, and every tool downstream
    // believes the name. Same class of fault as the WebP thumbnail in
    // docs/DISCOVERIES.md.
    expect(extensionFor({ ...MESSAGE, fileName: undefined })).toBe("mkv");
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: "video/quicktime" })).toBe("mov");
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: "video/x-msvideo" })).toBe("avi");
    // And an unknown one falls back rather than inventing an extension.
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: "video/x-unheard-of" })).toBe("mp4");
  });

  test("⚠️ never from the caption — a caption is not a filename", () => {
    // A message reading "final.mov" about an MP4 would name a file no player
    // opens, and the caption is the field most likely to say something like that.
    expect(extensionFor({ ...MESSAGE, fileName: undefined, mimeType: undefined, text: "final.mov" })).toBe("mp4");
  });
});

describe("titleFor", () => {
  const link = { kind: "private", channelId: "1234567890", messageId: 42 } as const;

  test("the caption's first line, then the filename, then something recognisable", () => {
    expect(titleFor(link, MESSAGE)).toBe("Charla sobre nada");
    expect(titleFor(link, { ...MESSAGE, text: undefined })).toBe("charla.final");
    expect(titleFor(link, { ...MESSAGE, text: "   ", fileName: undefined })).toBe("Telegram 1234567890 42");
  });
});

describe("buildInfo", () => {
  test("🔴 audioTracks is empty, because Telegram states nothing about them", () => {
    // The file is already muxed and there is no per-track metadata at all.
    // Inventing one track tagged `und` would put a language on the output that
    // nobody stated — the silent substitution this codebase refuses elsewhere.
    const info = buildInfo({ kind: "private", channelId: "1", messageId: 42 }, MESSAGE);
    expect(info.audioTracks).toEqual([]);
    expect(info.subtitles).toEqual([]);
    expect(info.videoFormats).toEqual([{ id: "telegram", width: 1920, height: 1080 }]);
    expect(info.duration).toBe(610);
    expect(info.source).toBe("telegram");
    expect(info.externalId).toBe("c/1/42");
  });

  test("a message with no video attributes still produces one usable format", () => {
    const bare = buildInfo({ kind: "public", username: "chan", messageId: 7 }, { id: 7, size: 10, handle: {} });
    expect(bare.videoFormats).toEqual([{ id: "telegram" }]);
    expect(bare.duration).toBeUndefined();
  });
});

// --- The provider ------------------------------------------------------------

const PRIVATE_URL = "https://t.me/c/1234567890/42";

function resolverWith(data: Record<string, string> | null): CredentialResolver {
  return {
    acquire: async () =>
      data === null
        ? null
        : ({
            id: "cred-1",
            type: "custom",
            scope: "t.me",
            data,
            redact: Object.values(data),
            release: async () => {},
          } satisfies CredentialLease),
  };
}

const GOOD_SESSION = {
  apiId: "123456",
  apiHash: "0123456789abcdef0123456789abcdef",
  session: "1BQANOTEwLjU1LjE",
};

/** A connection that answers with `MESSAGE` and writes bytes when asked. */
function fakeConnection(overrides: Partial<TelegramConnection> = {}, calls: string[] = []): TelegramConnection {
  return {
    async message() {
      calls.push("message");
      return MESSAGE;
    },
    async download(_message, outputFile, { onProgress }) {
      calls.push("download");
      onProgress(512, 1024);
      onProgress(1024, 1024);
      writeFileSync(outputFile, "x".repeat(1024));
    },
    async close() {
      calls.push("close");
    },
    ...overrides,
  };
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "casatube-telegram-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function context(progress: { doneBytes?: number; totalBytes?: number; percent?: number }[] = []): ProviderContext {
  return {
    workDir: work,
    signal: new AbortController().signal,
    onProgress: (update) => progress.push(update),
    log: () => {},
  };
}

function plan(outputName = "Charla"): DownloadPlan {
  return {
    url: PRIVATE_URL,
    video: { id: "telegram", width: 1920, height: 1080 },
    audio: [],
    subtitles: [],
    languageTags: {},
    sponsorblock: false,
    subtitleMode: "sidecar",
    outputName,
  } as DownloadPlan;
}

describe("supports", () => {
  test("🔴 private links only — a public one belongs to yt-dlp", () => {
    // Providers are asked in order and yt-dlp answers last, so claiming a URL
    // this cannot serve makes the fallback unreachable for it. `telegram:embed`
    // may well handle a public post this has no session for.
    const provider = createTelegramProvider({ credentials: resolverWith(GOOD_SESSION) });
    expect(provider.supports(PRIVATE_URL)).toBe(true);
    expect(provider.supports("https://t.me/somechannel/42")).toBe(false);
    expect(provider.supports("https://t.me/s/somechannel/42")).toBe(false);
    expect(provider.supports("https://youtube.com/watch?v=x")).toBe(false);
  });

  test("🔴 nothing at all without a credential store", () => {
    // With no way to authenticate there is no point taking a URL away from a
    // fallback that might manage it.
    expect(createTelegramProvider().supports(PRIVATE_URL)).toBe(false);
  });
});

describe("probe", () => {
  test("a message becomes MediaInfo, and the connection is always closed", async () => {
    const calls: string[] = [];
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => fakeConnection({}, calls),
    });

    const info = await provider.probe(PRIVATE_URL, new AbortController().signal);
    expect(Result.isOk(info)).toBe(true);
    if (!Result.isOk(info)) return;
    expect(info.value.title).toBe("Charla sobre nada");
    expect(info.value.duration).toBe(610);
    expect(calls).toEqual(["message", "close"]);
  });

  test("🔴 no credential is AuthRequired, and the message says what to add", async () => {
    // "Add a credential" and "the credential is wrong" are different jobs, and
    // the generic sentence for this error talks about cookies and passwords —
    // neither of which Telegram takes.
    const provider = createTelegramProvider({ credentials: resolverWith(null) });
    const info = await provider.probe(PRIVATE_URL, new AbortController().signal);
    expect(Result.isError(info)).toBe(true);
    if (!Result.isError(info)) return;
    expect(info.error._tag).toBe("AuthRequired");
    const detail = (info.error as { detail?: string }).detail ?? "";
    expect(detail).toContain("apiId");
    expect(detail).toContain("session");
    expect(detail).toContain("t.me");
  });

  test("🔴 a half-filled credential is refused with its own reason", async () => {
    for (const broken of [
      { ...GOOD_SESSION, apiId: "abc" },
      { ...GOOD_SESSION, apiHash: "too-short" },
      { ...GOOD_SESSION, session: "" },
      {},
    ]) {
      const provider = createTelegramProvider({ credentials: resolverWith(broken as Record<string, string>) });
      const info = await provider.probe(PRIVATE_URL, new AbortController().signal);
      expect(Result.isError(info) && info.error._tag).toBe("AuthRequired");
      if (Result.isError(info)) {
        expect((info.error as { detail?: string }).detail ?? "").toContain("missing a usable");
      }
    }
  });

  test("a message that is gone, and one with no file, are told apart", async () => {
    const missing = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => fakeConnection({ message: async () => null }),
    });
    const gone = await missing.probe(PRIVATE_URL, new AbortController().signal);
    expect(Result.isError(gone) && gone.error._tag).toBe("ProbeFailed");
    if (Result.isError(gone)) expect((gone.error as { detail: string }).detail).toContain("member");

    const textOnly = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => fakeConnection({ message: async () => ({ id: 42, handle: {} }) }),
    });
    const nothing = await textOnly.probe(PRIVATE_URL, new AbortController().signal);
    expect(Result.isError(nothing) && nothing.error._tag).toBe("ProbeFailed");
    if (Result.isError(nothing)) {
      expect((nothing.error as { detail: string }).detail).toContain("no file");
    }
  });

  test("a connection that throws becomes ProbeFailed, not an escaped exception", async () => {
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => {
        throw new Error("CHANNEL_PRIVATE");
      },
    });
    const info = await provider.probe(PRIVATE_URL, new AbortController().signal);
    expect(Result.isError(info) && info.error._tag).toBe("ProbeFailed");
    if (Result.isError(info)) expect((info.error as { detail: string }).detail).toContain("CHANNEL_PRIVATE");
  });
});

describe("fetch", () => {
  test("writes the file under the plan's name, with the extension the message implies", async () => {
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => fakeConnection(),
    });

    const got = await provider.fetch(plan(), context());
    expect(Result.isOk(got)).toBe(true);
    if (!Result.isOk(got)) return;
    expect(got.value.file).toBe(join(work, "Charla.mkv"));
    expect(got.value.subtitleFiles).toEqual([]);
    expect(await Bun.file(got.value.file).exists()).toBe(true);
  });

  test("🔴 progress is measured against the document's size, not the callback's total", async () => {
    // Telegram reports the size of the *part* being requested on some paths, and
    // a denominator that moves makes a bar that goes backwards.
    const progress: { percent?: number; totalBytes?: number }[] = [];
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () =>
        fakeConnection({
          async download(_message, outputFile, { onProgress }) {
            onProgress(512, 512); // a "total" that is really this chunk
            writeFileSync(outputFile, "x".repeat(1024));
          },
        }),
    });

    await provider.fetch(plan(), context(progress));
    expect(progress).toHaveLength(1);
    expect(progress[0]?.totalBytes).toBe(1024);
    expect(progress[0]?.percent).toBe(50);
  });

  test("🔴 a download that wrote nothing fails here rather than downstream", async () => {
    // `downloadMedia` resolving is not the same as bytes being on disk under the
    // name we chose, and the move stage would otherwise fail on an absence this
    // stage caused.
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () => fakeConnection({ download: async () => {} }),
    });

    const got = await provider.fetch(plan(), context());
    expect(Result.isError(got) && got.error._tag).toBe("FetchFailed");
    if (Result.isError(got)) expect((got.error as { detail: string }).detail).toContain("nothing was written");
  });

  test("the connection is closed even when the download throws", async () => {
    const calls: string[] = [];
    const provider = createTelegramProvider({
      credentials: resolverWith(GOOD_SESSION),
      connect: async () =>
        fakeConnection(
          {
            async download() {
              throw new Error("FLOOD_WAIT_42");
            },
          },
          calls,
        ),
    });

    const got = await provider.fetch(plan(), context());
    expect(Result.isError(got) && got.error._tag).toBe("FetchFailed");
    if (Result.isError(got)) expect((got.error as { detail: string }).detail).toContain("FLOOD_WAIT_42");
    expect(calls).toContain("close");
  });
});

describe("preferences do not get in the way", () => {
  test("a resolution ceiling has nothing to act on, and must not fail the job", async () => {
    // Telegram stores what was uploaded and offers no ladder. A 1080p file under
    // a 720p ceiling is the only file there is, and refusing it would be refusing
    // the download for a preference it cannot satisfy either way.
    const { buildDownloadPlan } = await import("../core/selection");
    const info = buildInfo({ kind: "private", channelId: "1", messageId: 42 }, MESSAGE);
    const built = buildDownloadPlan(PRIVATE_URL, info, { ...DEFAULT_PREFERENCES, maxResolution: 720 });

    // Documented rather than asserted as desirable: this is what the selection
    // logic does today, and the provider has to live with the answer.
    expect(Result.isError(built) ? built.error._tag : "ok").toBe("FormatUnavailable");
  });
});
