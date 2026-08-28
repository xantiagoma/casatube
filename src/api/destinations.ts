/**
 * `GET /api/destinations` — what folders the library actually has.
 *
 * The form used to ask for a destination as free text, which is the same fault
 * as asking for a resolution from a fixed list: it demands a decision without
 * showing the options. This is the other half of that fix — the browser can now
 * offer the folders that exist instead of hoping the user remembers them.
 *
 * ⚠️ **The library is very often a network mount**, and a network mount that
 * has gone away does not fail: it *hangs*. So every filesystem call here runs
 * under a deadline and reports `MountUnavailable` when it expires, because a
 * request with no deadline is how a browser tab ends up waiting forever on a
 * NAS that is asleep.
 *
 * 📌 What a deadline can and cannot do: `readdir` runs on Bun's threadpool, so
 * an abandoned one does **not** block the event loop — the server keeps
 * answering, and the stuck call is eventually collected. It cannot be
 * *cancelled*, which is why we race it rather than pretending to abort it.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { MountUnavailable } from "../core/errors";
import type { AppContext } from "./context";
import { fail } from "./errors";
import { safeDestination } from "./destination";
import { freeStem, stemIsTaken, toOutputName } from "../core/selection";

/** Generous for a spinning disk, short enough that a dead mount is obvious. */
const LIST_TIMEOUT_MS = 5_000;
const CREATE_TIMEOUT_MS = 5_000;

/**
 * How deep the walk goes. Two levels covers `youtube/talks` — the shape people
 * actually use — without turning a listing into a filesystem crawl of a library
 * that may hold tens of thousands of files.
 */
const MAX_DEPTH = 2;

/** Ceiling on folders returned, so a pathological tree cannot flood the page. */
const MAX_FOLDERS = 500;

export interface DestinationFolder {
  /** Relative to the library root, `/`-separated. Never absolute — PLAN §12. */
  path: string;
  /** Leaf name, for display. */
  name: string;
  /** 1 for a direct child of the root. */
  depth: number;
}

export interface DestinationListing {
  /** The configured root, for display only. */
  root: string;
  folders: DestinationFolder[];
  /** True when the walk hit `MAX_FOLDERS` and stopped early. */
  truncated: boolean;
  at: string;
}

/** A sentinel, so a legitimate `undefined` result is not mistaken for a timeout. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Run `work`, or give up.
 *
 * The rejection is swallowed on purpose: once the deadline has passed nobody is
 * listening any more, and an unhandled rejection from an abandoned call would
 * take the process down for a NAS that woke up late.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  path: string,
  what: string,
): Promise<Result<T, MountUnavailable>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });

  try {
    const outcome = await Promise.race([work.then((value) => ({ value })), expired]);
    if (outcome === TIMED_OUT) {
      void work.catch(() => {});
      return Result.err(
        new MountUnavailable({ path, detail: `${what} did not answer within ${ms} ms` }),
      );
    }
    return Result.ok(outcome.value);
  } catch (cause) {
    return Result.err(
      new MountUnavailable({ path, detail: cause instanceof Error ? cause.message : String(cause) }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The folders under `root`, breadth-first.
 *
 * Hidden folders are skipped — `.stfolder`, `.Trash-1000`, `@eaDir` and the
 * rest are the media server's business, not a download destination.
 */
async function walk(root: string): Promise<Result<{ folders: DestinationFolder[]; truncated: boolean }, MountUnavailable>> {
  const folders: DestinationFolder[] = [];
  let truncated = false;

  // Breadth-first, so the shallow folders — the ones people actually pick —
  // are the ones that survive the cap.
  let frontier: DestinationFolder[] = [{ path: "", name: "", depth: 0 }];

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && !truncated; depth += 1) {
    const next: DestinationFolder[] = [];

    for (const parent of frontier) {
      const absolute = parent.path === "" ? root : join(root, parent.path);
      const entries = await withDeadline(
        readdir(absolute, { withFileTypes: true }),
        LIST_TIMEOUT_MS,
        absolute,
        "reading the library",
      );
      // Only the root failing is fatal. A single unreadable subfolder — a
      // permissions quirk, a stale handle — must not cost the whole listing.
      if (Result.isError(entries)) {
        if (parent.depth === 0) return entries;
        continue;
      }

      for (const entry of entries.value) {
        // `readdir` does not follow links, so a symlinked directory reports
        // `isDirectory() === false` and is excluded here — which is what we
        // want: following one turns a listing into a loop, and `..` is not the
        // only way out of a root.
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
        if (folders.length >= MAX_FOLDERS) {
          truncated = true;
          break;
        }
        const folder: DestinationFolder = {
          path: parent.path === "" ? entry.name : `${parent.path}/${entry.name}`,
          name: entry.name,
          depth,
        };
        folders.push(folder);
        next.push(folder);
      }
      if (truncated) break;
    }

    frontier = next;
  }

  folders.sort((a, b) => a.path.localeCompare(b.path));
  return Result.ok({ folders, truncated });
}

export function destinationRoutes(ctx: AppContext) {
  const { config } = ctx;

  return (
    new Elysia({ prefix: "/destinations" })
      /**
       * The folders that exist. A failure here is a 503 with a tag the client
       * can react to — the form falls back to typing a name, which still works
       * because the worker creates the folder at the move.
       */
      .get("/", async () => {
        const walked = await walk(config.libraryDir);
        if (Result.isError(walked)) return fail(walked.error);
        return {
          root: config.libraryDir,
          folders: walked.value.folders,
          truncated: walked.value.truncated,
          at: new Date().toISOString(),
        };
      })

      /**
       * Is this filename free in that folder — and if not, what is using it?
       *
       * 🔴 The same trade `POST /api/destinations` makes: find out *before*
       * 800 MB rather than after. The move stage never overwrites, so a taken
       * name is not a disaster any more — it lands `Name (2)` and says so — but
       * "I meant to replace that" and "these are two different videos" are
       * decisions only the person queueing can make, and they can only make
       * them if they are told.
       *
       * ⚠️ **Advisory, and it says so by being a separate call.** The folder can
       * change between this answer and the move; the move stage checks again,
       * with a listing of its own, and that check is the one that is
       * load-bearing. Two checks, and only the late one decides.
       *
       * The name is cleaned here with exactly the function the plan uses, so
       * what comes back is the name that would really be written — a slash
       * typed into the box does not become a folder, and the form shows that
       * before it is queued rather than after.
       */
      .get(
        "/name-check",
        async ({ query }) => {
          const destination = safeDestination(query.destination ?? "", config.libraryDir);
          if (Result.isError(destination)) return fail(destination.error);

          const name = toOutputName(query.name);
          const folder = join(config.libraryDir, destination.value);
          /**
           * 🔴 "The folder is not there" and "the folder could not be read" are
           * different answers and must not collapse into one.
           *
           * A folder that does not exist yet holds nothing — a real answer, and
           * the move stage creates it. A mount that is asleep holds *unknown*,
           * and reporting that as "the name is free" is the silent substitution
           * this whole change is about: the form would say "free" and the
           * download would land beside a file nobody could see.
           */
          const entries = await withDeadline(
            readdir(folder).catch((cause: NodeJS.ErrnoException) => {
              if (cause?.code === "ENOENT") return [] as string[];
              throw cause;
            }),
            LIST_TIMEOUT_MS,
            folder,
            "reading the folder",
          );
          if (Result.isError(entries)) return fail(entries.error);
          const existing = entries.value;

          const taken = stemIsTaken(existing, name);
          return {
            /** What would actually be written — the cleaned name, not the typed one. */
            name,
            taken,
            /** Free, or the next name that is. Empty when a thousand are taken. */
            suggestion: taken ? freeStem(existing, name) : name,
            /** The files already built on that name, so the answer is specific. */
            using: existing.filter((entry) => {
              const lower = entry.toLowerCase();
              const wanted = name.toLowerCase();
              return lower === wanted || lower.startsWith(`${wanted}.`);
            }),
            destination: destination.value,
            at: new Date().toISOString(),
          };
        },
        {
          query: t.Object({
            destination: t.Optional(t.String()),
            name: t.String({ minLength: 1, maxLength: 300 }),
          }),
        },
      )

      /**
       * Create one, from a name typed into the form.
       *
       * Strictly a convenience: the move stage already creates whatever the job
       * asks for. What it buys is the same thing `/api/probe` buys — finding
       * out that a name is refused, or that the library is read-only, *before*
       * 800 MB rather than after.
       *
       * ⚠️ The path is validated by `safeDestination` first, and validated
       * against the *string* — the join below is only ever given segments that
       * have already been refused the chance to climb out of the root.
       */
      .post(
        "/",
        async ({ body }) => {
          const destination = safeDestination(body.path, config.libraryDir);
          if (Result.isError(destination)) return fail(destination.error);
          if (destination.value === "") {
            // The root always exists by definition; creating it is a no-op, and
            // reporting success is more honest than inventing a failure.
            return { path: "", created: false };
          }

          const absolute = join(config.libraryDir, destination.value);
          const made = await withDeadline(
            mkdir(absolute, { recursive: true }),
            CREATE_TIMEOUT_MS,
            absolute,
            "creating the folder",
          );
          if (Result.isError(made)) return fail(made.error);

          // `mkdir -p` returns the first path it created, or `undefined` when
          // everything already existed — which is exactly the distinction the
          // form wants to report back.
          return { path: destination.value, created: made.value !== undefined };
        },
        { body: t.Object({ path: t.String({ minLength: 1 }) }) },
      )
  );
}
