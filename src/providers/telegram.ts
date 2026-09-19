/**
 * Telegram, over MTProto — the one source yt-dlp cannot reach.
 *
 * yt-dlp has exactly one Telegram extractor, `telegram:embed`, and it reads the
 * *public* web preview a channel publishes at `t.me/<name>/<id>`: an HTML page
 * with an ordinary HTTPS video URL in it. A **private** channel has no such page.
 * `t.me/c/<id>/<msg>` is not a document anybody can fetch, and the video is never
 * a URL at all — it arrives as encrypted chunks from a data centre, requested
 * with `upload.getFile` and reassembled by the client. There is nothing for an
 * HTTP downloader to point at, with or without cookies.
 *
 * So this is a provider rather than a plugin, for two reasons that both come
 * down to what a plugin can reach: a plugin file in `DATA_DIR` is imported by
 * this process, so it can only import what the *app* has installed — and
 * `teleproto` has to be an app dependency either way — and the session lives in
 * the credential store, which the plugin API does not expose.
 *
 * ## What it claims, and what it deliberately leaves alone
 *
 * 🔴 **Private links only.** Providers are asked in registration order and
 * yt-dlp answers last, so a provider that claims a URL it cannot serve makes the
 * fallback unreachable for it. `telegram:embed` may well handle a public post
 * that this has no session for, and turning that into a failure would be a
 * regression — so `t.me/<name>/<id>` keeps going to yt-dlp. Private links are
 * the ones nothing else can do.
 *
 * ## One connection per operation
 *
 * ⚠️ The client is built, used and disconnected inside each call. An MTProto
 * connection held across calls would be a connection held across a *plugin
 * reload* and across the idle hours between downloads, and a dead one fails at
 * the moment somebody is watching rather than at the moment it died. Connecting
 * costs a handshake against an authorised session, which is milliseconds, not a
 * login.
 */
import { Result } from "better-result";

import type { CredentialResolver } from "../core/credentials";
import { AuthRequired, FetchFailed, ProbeFailed, type ProviderError } from "../core/errors";
import type {
  DownloadPlan,
  MediaInfo,
  Provider,
  ProviderContext,
  FetchResult,
} from "../core/types";

/** The scope a Telegram credential is stored under. */
export const TELEGRAM_SCOPE = "t.me";

/** Hosts that mean Telegram. `telegram.dog` is a real alias Telegram serves. */
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

/**
 * A link to one message.
 *
 * `private` carries the channel's **internal** id — the number in `t.me/c/…`,
 * which is the channel id without the `-100` prefix MTProto marks channels with.
 */
export type TelegramLink =
  | { kind: "private"; channelId: string; messageId: number }
  | { kind: "public"; username: string; messageId: number };

/**
 * Parse a `t.me` link, or answer `null`.
 *
 * Pure, and the only part of this file a test can reach without an account —
 * which is why every shape Telegram actually produces is handled here rather
 * than guessed at further in:
 *
 * | | |
 * |---|---|
 * | `t.me/c/1234567890/42` | a private channel, message 42 |
 * | `t.me/c/1234567890/7/42` | the same, inside forum topic 7 |
 * | `t.me/channelname/42` | a public post |
 * | `t.me/channelname/7/42` | a public post in a topic |
 *
 * ⚠️ The **last** number is the message. In the topic form the first one is the
 * thread, and reading it as the message id downloads whatever happens to be at
 * the top of the topic — a wrong file, successfully.
 *
 * `?single`, `?comment=`, `?t=` and the rest are ignored: they say how a client
 * should *display* the message, not which message it is.
 */
export function parseTelegramLink(url: string): TelegramLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!TELEGRAM_HOSTS.has(parsed.hostname.toLowerCase().replace(/^www\./, ""))) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;

  // `t.me/s/<name>/<id>` is the *web preview* — a different thing, and the one
  // yt-dlp's extractor reads. Leaving it alone rather than claiming it.
  if (segments[0] === "s") return null;

  if (segments[0] === "c") {
    // c / <channelId> / [threadId] / <messageId>
    const channelId = segments[1];
    const messageId = asMessageId(segments.at(-1));
    if (channelId === undefined || !/^\d+$/.test(channelId) || messageId === null) return null;
    if (segments.length < 3) return null;
    return { kind: "private", channelId, messageId };
  }

  // ⚠️ An invite link is not a message link. `t.me/+AbCd` and `t.me/joinchat/…`
  // name a chat to *join*, and a provider that claimed them would fail on
  // something a person could reasonably paste.
  const username = segments[0];
  if (username === undefined || username.startsWith("+") || username === "joinchat") return null;
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) return null;

  const messageId = asMessageId(segments.at(-1));
  if (messageId === null) return null;
  return { kind: "public", username, messageId };
}

function asMessageId(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The `-100`-marked channel id MTProto wants, from the number in a `t.me/c/` URL.
 *
 * ⚠️ A string, not a number: channel ids pass 2^53 and `Number` would round one
 * into a different channel. `BigInt` is what teleproto takes.
 */
export function markedChannelId(channelId: string): bigint {
  return BigInt(`-100${channelId}`);
}

export interface TelegramOptions {
  /**
   * Where the session comes from.
   *
   * Absent means the provider claims nothing: with no way to authenticate there
   * is no point taking a URL away from a fallback that might manage it.
   */
  credentials?: CredentialResolver;
  /** Injectable for tests. Defaults to the real `teleproto` client. */
  connect?: (session: TelegramSession) => Promise<TelegramConnection>;
}

/** The three values a `custom` credential scoped to `t.me` holds. */
export interface TelegramSession {
  apiId: number;
  apiHash: string;
  session: string;
}

/**
 * The slice of a Telegram client this provider uses.
 *
 * Named so the provider can be driven by a fake: everything below is one
 * `getMessages` and one `downloadMedia`, and a test that had to stand up MTProto
 * to reach them would test teleproto rather than this file.
 */
export interface TelegramConnection {
  message(link: TelegramLink, signal: AbortSignal): Promise<TelegramMessage | null>;
  download(
    message: TelegramMessage,
    outputFile: string,
    options: { signal: AbortSignal; onProgress(done: number, total: number): void },
  ): Promise<void>;
  close(): Promise<void>;
}

/** What the provider needs to know about one message. */
export interface TelegramMessage {
  id: number;
  /** The caption's first line, when there is one. */
  text?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Passed back to `download` untouched — the provider never inspects it. */
  handle: unknown;
}

function sessionFrom(data: Record<string, string> | undefined): TelegramSession | null {
  const apiId = Number(data?.apiId ?? "");
  const apiHash = data?.apiHash ?? "";
  const session = data?.session ?? "";
  if (!Number.isInteger(apiId) || apiId <= 0) return null;
  if (!/^[0-9a-f]{32}$/i.test(apiHash) || session === "") return null;
  return { apiId, apiHash, session };
}

/**
 * The extension to save under.
 *
 * From the filename Telegram carries when it has one, then the MIME type, then
 * `.mp4` — which is what the overwhelming majority of Telegram video actually
 * is. ⚠️ Never derived from the *caption*: a message saying "final.mov" about an
 * MP4 would name a file that no player opens.
 */
export function extensionFor(message: TelegramMessage): string {
  const fromName = /\.([A-Za-z0-9]{2,5})$/.exec(message.fileName ?? "");
  if (fromName?.[1]) return fromName[1].toLowerCase();

  const mime = message.mimeType?.toLowerCase() ?? "";
  const mapped = MIME_EXTENSIONS[mime];
  if (mapped !== undefined) return mapped;

  // A subtype that happens to *be* an extension — `video/mp4`, `video/webm`.
  const subtype = /^video\/([a-z0-9]{2,5})$/.exec(mime)?.[1];
  return subtype ?? "mp4";
}

/**
 * MIME types whose subtype is not the extension.
 *
 * 🔴 Small and load-bearing. Without it a Matroska file that arrives with no
 * filename is saved as `.mp4`, and a container named after a format it is not is
 * the same class of fault as the WebP thumbnail in `docs/DISCOVERIES.md`: every
 * tool downstream believes the name, and the failure surfaces as "my player will
 * not open this" a long way from here.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/mpeg": "mpg",
  "video/x-ms-wmv": "wmv",
  "video/x-flv": "flv",
  "video/3gpp": "3gp",
};

/** A title, in the order of what a person would recognise. */
export function titleFor(link: TelegramLink, message: TelegramMessage): string {
  const caption = message.text?.split("\n")[0]?.trim();
  if (caption !== undefined && caption !== "") return caption;
  const name = message.fileName?.replace(/\.[A-Za-z0-9]{2,5}$/, "").trim();
  if (name !== undefined && name !== "") return name;
  const where = link.kind === "private" ? link.channelId : link.username;
  return `Telegram ${where} ${message.id}`;
}

export function createTelegramProvider(options: TelegramOptions = {}): Provider {
  const connect = options.connect ?? defaultConnect;

  /**
   * Resolve a session, or say which of the two reasons stopped us.
   *
   * ⚠️ The difference matters to whoever pasted the link: "add a Telegram
   * credential" and "the credential you added is not usable" are different jobs,
   * and one message covering both is a message that helps with neither.
   */
  async function session(url: string): Promise<Result<TelegramSession, AuthRequired>> {
    const lease = (await options.credentials?.acquire(url, ["custom"])) ?? null;
    if (lease === null) {
      return Result.err(
        new AuthRequired({
          url,
          detail:
            "A private Telegram channel needs a signed-in session. Add a credential under " +
            `Settings → Credentials: type "custom", site "${TELEGRAM_SCOPE}", with the fields ` +
            "apiId, apiHash and session — scripts/telegram-session.ts prints the last one.",
        }),
      );
    }
    try {
      const resolved = sessionFrom(lease.data);
      if (resolved === null) {
        return Result.err(
          new AuthRequired({
            url,
            detail:
              `The credential for ${TELEGRAM_SCOPE} is missing a usable apiId, apiHash or session. ` +
              "apiId is digits, apiHash is 32 hex characters, session is the string the login script printed.",
          }),
        );
      }
      return Result.ok(resolved);
    } finally {
      await lease.release();
    }
  }

  return {
    name: "telegram",

    supports(url: string): boolean {
      // See the header: private links only, and nothing at all without a way to
      // authenticate — claiming a URL this cannot serve would take it away from
      // a fallback that might.
      if (options.credentials === undefined) return false;
      return parseTelegramLink(url)?.kind === "private";
    },

    async probe(url, signal) {
      const link = parseTelegramLink(url);
      if (link === null) return Result.err(new ProbeFailed({ url, detail: "not a Telegram message link" }));

      const authorised = await session(url);
      if (Result.isError(authorised)) return authorised;

      let connection: TelegramConnection | undefined;
      try {
        connection = await connect(authorised.value);
        const message = await connection.message(link, signal);
        if (message === null) {
          return Result.err(
            new ProbeFailed({
              url,
              detail:
                "Telegram returned no message there. The account may not be a member of that " +
                "channel, or the message may have been deleted.",
            }),
          );
        }
        if (message.size === undefined) {
          return Result.err(
            new ProbeFailed({ url, detail: "That message carries no file — only text, a photo or a sticker." }),
          );
        }

        return Result.ok(buildInfo(link, message));
      } catch (cause) {
        return Result.err(new ProbeFailed({ url, detail: describe(cause) }));
      } finally {
        await connection?.close().catch(() => {});
      }
    },

    async fetch(plan, ctx) {
      const link = parseTelegramLink(plan.url);
      if (link === null) {
        return Result.err(new FetchFailed({ url: plan.url, detail: "not a Telegram message link" }));
      }

      const authorised = await session(plan.url);
      if (Result.isError(authorised)) return authorised;

      let connection: TelegramConnection | undefined;
      try {
        connection = await connect(authorised.value);
        const message = await connection.message(link, ctx.signal);
        if (message === null || message.size === undefined) {
          return Result.err(
            new FetchFailed({ url: plan.url, detail: "the message or its file is gone since it was analyzed" }),
          );
        }

        const file = `${ctx.workDir}/${plan.outputName}.${extensionFor(message)}`;
        const total = message.size;
        ctx.log(`telegram: ${plan.outputName} (${total} bytes)`);

        await connection.download(message, file, {
          signal: ctx.signal,
          onProgress: (done, reported) => {
            // ⚠️ `total` from the document, not from the callback: Telegram
            // reports the size of the *part* being requested on some paths, and
            // a denominator that moves makes a progress bar that goes backwards.
            const size = total > 0 ? total : reported;
            ctx.onProgress({
              stage: "download",
              doneBytes: done,
              totalBytes: size,
              ...(size > 0 ? { percent: Math.min(100, Math.round((done / size) * 100)) } : {}),
            });
          },
        });

        // 🔴 Verified rather than assumed: `downloadMedia` resolving is not the
        // same as bytes being on disk under the name we chose, and the move stage
        // downstream would otherwise fail on an absence this stage caused.
        const written = Bun.file(file);
        const size = await written.exists().then((yes) => (yes ? written.size : 0));
        if (size === 0) {
          return Result.err(new FetchFailed({ url: plan.url, detail: `nothing was written to ${file}` }));
        }

        return Result.ok({ file, subtitleFiles: [] } satisfies FetchResult);
      } catch (cause) {
        return Result.err(new FetchFailed({ url: plan.url, detail: describe(cause) }));
      } finally {
        await connection?.close().catch(() => {});
      }
    },
  };
}

/**
 * `MediaInfo` for one Telegram video.
 *
 * ⚠️ **`audioTracks` is empty, and that is the honest answer.** The file is
 * already muxed and Telegram publishes no per-track metadata — no language, no
 * channel count, nothing. Inventing one track tagged `und` would put a language
 * tag on the output that nobody stated, which is the silent substitution this
 * codebase refuses everywhere else. `selectAudioTracks` is content with an empty
 * list; the audio in the file is untouched either way, because nothing is
 * remuxed.
 */
export function buildInfo(link: TelegramLink, message: TelegramMessage): MediaInfo {
  const where = link.kind === "private" ? `c/${link.channelId}` : link.username;
  return {
    externalId: `${where}/${message.id}`,
    title: titleFor(link, message),
    source: "telegram",
    ...(message.durationSeconds === undefined ? {} : { duration: message.durationSeconds }),
    // One format, because there is one file. Telegram stores what was uploaded
    // and offers no ladder to choose from — the resolution ceiling has nothing
    // to act on here, which `selectVideoFormat` handles by taking what exists.
    videoFormats: [
      {
        id: "telegram",
        ...(message.width === undefined ? {} : { width: message.width }),
        ...(message.height === undefined ? {} : { height: message.height }),
      },
    ],
    audioTracks: [],
    subtitles: [],
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * The real client, imported only when one is actually needed.
 *
 * ⚠️ A dynamic import on purpose: `teleproto` pulls in a socket stack and its
 * own crypto, and a server that never touches a Telegram link should not pay for
 * that at boot.
 */
async function defaultConnect(session: TelegramSession): Promise<TelegramConnection> {
  const { TelegramClient, Api, sessions } = await import("teleproto");
  const client = new TelegramClient(
    new sessions.StringSession(session.session),
    session.apiId,
    session.apiHash,
    { connectionRetries: 3 },
  );
  await client.connect();

  return {
    async message(link, signal) {
      signal.throwIfAborted();
      const peer =
        link.kind === "private"
          ? await client.getEntity(markedChannelId(link.channelId).toString())
          : await client.getEntity(link.username);
      const found = await client.getMessages(peer, { ids: [link.messageId] });
      const message = found[0];
      if (!message) return null;

      const document = (message.media as { document?: unknown } | undefined)?.document as
        | {
            size?: { toJSNumber?(): number };
            mimeType?: string;
            attributes?: unknown[];
          }
        | undefined;
      if (document === undefined) return null;

      const attributes = (document.attributes ?? []) as Record<string, unknown>[];
      const video = attributes.find((attribute) => attribute instanceof Api.DocumentAttributeVideo) as
        | { duration?: number; w?: number; h?: number }
        | undefined;
      const named = attributes.find((attribute) => attribute instanceof Api.DocumentAttributeFilename) as
        | { fileName?: string }
        | undefined;

      return {
        id: link.messageId,
        ...(typeof message.message === "string" && message.message !== ""
          ? { text: message.message }
          : {}),
        ...(named?.fileName === undefined ? {} : { fileName: named.fileName }),
        ...(document.mimeType === undefined ? {} : { mimeType: document.mimeType }),
        ...(document.size?.toJSNumber === undefined ? {} : { size: document.size.toJSNumber() }),
        ...(video?.duration === undefined ? {} : { durationSeconds: Math.round(video.duration) }),
        ...(video?.w === undefined ? {} : { width: video.w }),
        ...(video?.h === undefined ? {} : { height: video.h }),
        handle: message,
      };
    },

    async download(message, outputFile, { signal, onProgress }) {
      await client.downloadMedia(message.handle as never, {
        outputFile,
        signal,
        progressCallback: (done, total) => {
          onProgress(Number(done.toString()), Number(total.toString()));
        },
      });
    },

    async close() {
      await client.disconnect();
    },
  };
}
