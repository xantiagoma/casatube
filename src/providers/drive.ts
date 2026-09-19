/**
 * Google Drive, without the API key that is broken.
 *
 * 🔴 **Why this exists.** yt-dlp's Drive extractor asks
 * `googleapis.com/drive/v3` for metadata using an API key **compiled into
 * yt-dlp and shared by every one of its users**. When that key is being
 * refused — measured here: 429 for yt-dlp, 403 for the same key from curl — the
 * extractor aborts *before touching a byte of video* and writes nothing. It is
 * not a metadata inconvenience; it is a download that cannot happen, for a
 * reason nobody downstream can influence.
 *
 * Meanwhile the file itself is served perfectly. So this takes the path that
 * works and skips the part that does not:
 *
 * 1. Ask `drive.usercontent.google.com/download?id=…&export=download`.
 * 2. A small file answers with the bytes. A large one answers with Drive's
 *    **virus scan warning** — an HTML page whose form carries a `confirm` token
 *    and a `uuid`.
 * 3. Follow that form. The answer is the file, with `Accept-Ranges`, which is
 *    how seeking and resuming work.
 *
 * ⚠️ **This is scraping, and it will need maintenance that the Telegram provider
 * does not.** MTProto is a protocol with a contract; this is a page Google can
 * change on a Tuesday. The trade is deliberate: the alternative is scraping
 * *plus* a dead shared key, which is strictly worse. `confirmTarget` parses the
 * form generically — every hidden input, whatever it is called — rather than
 * looking for `confirm=t`, so a renamed token is survivable.
 *
 * ⚠️ **Public files only.** A private one answers with a sign-in page, which is
 * reported as `AuthRequired` naming the cookie credential that would fix it.
 * That path is untested — see `HANDOFF.md`.
 */
import { Result } from "better-result";

import { AuthRequired, FetchFailed, ProbeFailed } from "../core/errors";
import type { MediaInfo, Provider, FetchResult } from "../core/types";

/** Hosts that serve a Drive file link. */
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com", "drive.usercontent.google.com"]);

/**
 * Where a download starts. `usercontent` rather than `drive.google.com/uc`,
 * because that is the host Drive itself redirects to and the one that answers
 * with ranges.
 */
const DOWNLOAD_ENDPOINT = "https://drive.usercontent.google.com/download";

/**
 * A Drive file id out of any of the shapes people paste.
 *
 * | | |
 * |---|---|
 * | `drive.google.com/file/d/<id>/view` | the share link |
 * | `drive.google.com/open?id=<id>` | the older share link |
 * | `drive.google.com/uc?id=<id>&export=download` | a direct link |
 * | `drive.usercontent.google.com/download?id=<id>` | what the form posts to |
 *
 * ⚠️ **A folder is not a file.** `drive.google.com/drive/folders/<id>` names a
 * listing, and claiming it would fail on something a person could reasonably
 * paste — so it is left alone rather than half-handled.
 */
export function parseDriveId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!DRIVE_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");

  // A folder, a shared drive, or the "my drive" UI: all listings, none a file.
  if (segments[0] === "drive") return null;

  if (segments[0] === "file" && segments[1] === "d") return validId(segments[2]);
  const fromQuery = parsed.searchParams.get("id");
  if (fromQuery !== null) return validId(fromQuery);
  return null;
}

/**
 * ⚠️ Checked for shape rather than accepted. A Drive id is a long opaque token;
 * anything shorter is a fragment of a URL we misread, and turning that into a
 * request is how a provider claims a link it cannot serve.
 */
function validId(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  return /^[A-Za-z0-9_-]{10,}$/.test(candidate) ? candidate : null;
}

/** The first download attempt for an id. */
export function downloadUrl(id: string): string {
  return `${DOWNLOAD_ENDPOINT}?id=${encodeURIComponent(id)}&export=download`;
}

/**
 * The URL Drive's warning page is really asking us to follow.
 *
 * 🔴 Built from **every hidden input in the form**, not from a search for
 * `confirm=t`. The token's name is Google's to change, and a parser that knows
 * only today's name fails on a page that still contains everything it needs.
 * Returns `null` when there is no form — which is how "this is a sign-in page"
 * and "this is the file" are told apart from "this is the warning".
 */
export function confirmTarget(html: string): string | null {
  const form = /<form[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form === null) return null;

  const action = decodeEntities(form[1] ?? "");
  if (!action.startsWith("https://")) return null;

  const target = new URL(action);
  for (const input of (form[2] ?? "").matchAll(/<input[^>]*>/gi)) {
    const tag = input[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (name) target.searchParams.set(name, decodeEntities(value));
  }
  return target.searchParams.has("id") ? target.toString() : null;
}

/** The handful that appear in a Drive form's action. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The filename Drive states, out of `content-disposition`. */
export function filenameFrom(disposition: string | null): string | undefined {
  if (disposition === null) return undefined;
  const quoted = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(disposition)?.[1];
  if (quoted === undefined) return undefined;
  try {
    return decodeURIComponent(quoted).trim() || undefined;
  } catch {
    return quoted.trim() || undefined;
  }
}

/** What one Drive file turned out to be. */
export interface DriveFile {
  id: string;
  /** The URL that actually serves bytes, confirmation followed. */
  url: string;
  filename?: string;
  mimeType?: string;
  /** Total bytes, from `content-range` or `content-length`. */
  size?: number;
}

export interface DriveOptions {
  /** Injectable so the whole flow is testable without Google. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Resolve an id to something that serves bytes, following the warning page.
 *
 * ⚠️ A `Range: bytes=0-0` probe rather than a HEAD: Drive answers HEAD
 * inconsistently on this endpoint, and one byte with a `content-range` gives the
 * exact total, the type and the filename for the price of a round trip.
 */
export async function resolveDriveFile(
  id: string,
  doFetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<Result<DriveFile, AuthRequired | ProbeFailed>> {
  const first = await doFetch(downloadUrl(id), { signal, redirect: "follow" });
  const type = first.headers.get("content-type") ?? "";

  // A small file: the bytes came straight back.
  if (!type.includes("text/html")) {
    if (!first.ok) {
      return Result.err(
        new ProbeFailed({ url: downloadUrl(id), detail: `Drive answered ${first.status} for that file.` }),
      );
    }
    await first.body?.cancel();
    return Result.ok(described(id, downloadUrl(id), first));
  }

  const html = await first.text();
  const target = confirmTarget(html);
  if (target === null) {
    /**
     * 🔴 No form means no download to confirm, and the two reasons for that are
     * worth telling apart: a file that needs an account, and a file that is not
     * there. Drive titles its pages, which is the cheapest honest signal.
     */
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    if (/sign in|denied|permission|request access/i.test(`${title} ${html.slice(0, 2000)}`)) {
      return Result.err(
        new AuthRequired({
          url: downloadUrl(id),
          detail:
            "That Drive file is not public. Add a cookies credential under Settings → Credentials with " +
            'site "drive.google.com" — a Netscape cookies.txt exported while signed in.',
        }),
      );
    }
    return Result.err(
      new ProbeFailed({
        url: downloadUrl(id),
        detail: `Drive answered a page rather than a file${title === "" ? "" : `: ${title}`}.`,
      }),
    );
  }

  // One byte, to learn the size and the type without downloading.
  const probe = await doFetch(target, { signal, headers: { range: "bytes=0-0" }, redirect: "follow" });
  if (!probe.ok) {
    return Result.err(
      new ProbeFailed({ url: target, detail: `Drive answered ${probe.status} after the confirmation.` }),
    );
  }
  await probe.body?.cancel();
  return Result.ok(described(id, target, probe));
}

function described(id: string, url: string, response: Response): DriveFile {
  const range = response.headers.get("content-range");
  const total = /\/(\d+)\s*$/.exec(range ?? "")?.[1];
  const length = response.headers.get("content-length");
  const size = total !== undefined ? Number(total) : length !== null && range === null ? Number(length) : undefined;

  return {
    id,
    url,
    ...(filenameFrom(response.headers.get("content-disposition")) === undefined
      ? {}
      : { filename: filenameFrom(response.headers.get("content-disposition")) }),
    ...(response.headers.get("content-type") === null
      ? {}
      : { mimeType: response.headers.get("content-type")!.split(";")[0]!.trim() }),
    ...(size === undefined || !Number.isFinite(size) ? {} : { size }),
  };
}

/** `Name.mp4` → `Name`. The extension is decided separately, from the type. */
export function titleFrom(file: DriveFile): string {
  const name = file.filename?.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return name !== undefined && name !== "" ? name : `Drive ${file.id.slice(0, 8)}`;
}

/** MIME subtypes that are not their own extension. */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",
  "video/mpeg": "mpg",
  "audio/mpeg": "mp3",
};

/**
 * The extension to save under: the filename's, then the type's, then `mp4`.
 *
 * ⚠️ The filename wins because Drive states it and it is what the uploader
 * chose. Same reasoning as the Telegram provider, and the same failure avoided:
 * a container named after a format it is not.
 */
export function extensionFor(file: DriveFile): string {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(file.filename ?? "")?.[1];
  if (fromName !== undefined) return fromName.toLowerCase();
  const mime = file.mimeType?.toLowerCase() ?? "";
  const mapped = MIME_EXTENSIONS[mime];
  if (mapped !== undefined) return mapped;
  const subtype = /^(?:video|audio)\/([a-z0-9]{2,5})$/.exec(mime)?.[1];
  return subtype ?? "mp4";
}

/**
 * `MediaInfo` for a Drive file.
 *
 * ⚠️ **No duration, no dimensions, one format, and no audio tracks** — because
 * Drive states none of it. Reading them would mean downloading the file and
 * probing it, which is the thing a probe exists to avoid. A format with no
 * dimensions is the "last resort" pool in `selectVideoFormat`, so it is chosen
 * at any ceiling rather than refused by one, which is the correct answer for a
 * source with exactly one file.
 */
export function buildInfo(file: DriveFile): MediaInfo {
  return {
    externalId: file.id,
    title: titleFrom(file),
    source: "drive",
    videoFormats: [{ id: "drive" }],
    audioTracks: [],
    subtitles: [],
  };
}

export function createDriveProvider(options: DriveOptions = {}): Provider {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    name: "drive",

    supports(url: string): boolean {
      return parseDriveId(url) !== null;
    },

    async probe(url, signal) {
      const id = parseDriveId(url);
      if (id === null) return Result.err(new ProbeFailed({ url, detail: "not a Drive file link" }));

      try {
        const file = await resolveDriveFile(id, doFetch, signal);
        if (Result.isError(file)) return file;
        return Result.ok(buildInfo(file.value));
      } catch (cause) {
        return Result.err(new ProbeFailed({ url, detail: describe(cause) }));
      }
    },

    async fetch(plan, ctx) {
      const id = parseDriveId(plan.url);
      if (id === null) return Result.err(new FetchFailed({ url: plan.url, detail: "not a Drive file link" }));

      try {
        const resolved = await resolveDriveFile(id, doFetch, ctx.signal);
        if (Result.isError(resolved)) {
          const error = resolved.error;
          if (error._tag === "AuthRequired") return Result.err(error);
          return Result.err(new FetchFailed({ url: plan.url, detail: error.detail }));
        }
        const file = resolved.value;

        const response = await doFetch(file.url, { signal: ctx.signal, redirect: "follow" });
        if (!response.ok || response.body === null) {
          return Result.err(
            new FetchFailed({ url: plan.url, detail: `Drive answered ${response.status} for the download.` }),
          );
        }

        const target = `${ctx.workDir}/${plan.outputName}.${extensionFor(file)}`;
        const total = file.size ?? Number(response.headers.get("content-length") ?? 0);
        ctx.log(`drive: ${plan.outputName} (${total > 0 ? `${total} bytes` : "size unknown"})`);

        const sink = Bun.file(target).writer();
        let done = 0;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            sink.write(chunk);
            done += chunk.byteLength;
            ctx.onProgress({
              stage: "download",
              doneBytes: done,
              ...(total > 0 ? { totalBytes: total, percent: Math.min(100, Math.round((done / total) * 100)) } : {}),
            });
          }
        } finally {
          await sink.end();
        }

        /**
         * 🔴 Verified, and against the **stated size** when there is one.
         *
         * A truncated HTTP download is the ordinary failure here — a reset
         * connection ends the stream and everything looks finished. Comparing
         * bytes written against `content-range`'s total is the only thing that
         * tells a complete file from half of one, and half a file that the move
         * stage happily files away is worse than a failure.
         */
        const written = Bun.file(target);
        const onDisk = (await written.exists()) ? written.size : 0;
        if (onDisk === 0) {
          return Result.err(new FetchFailed({ url: plan.url, detail: `nothing was written to ${target}` }));
        }
        if (total > 0 && onDisk !== total) {
          return Result.err(
            new FetchFailed({
              url: plan.url,
              detail: `the download stopped early: ${onDisk} of ${total} bytes`,
            }),
          );
        }

        return Result.ok({ file: target, subtitleFiles: [] } satisfies FetchResult);
      } catch (cause) {
        return Result.err(new FetchFailed({ url: plan.url, detail: describe(cause) }));
      }
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
