/**
 * Destination validation — the API's half of "never write outside the library".
 *
 * The schema says a destination is a **library subfolder, never an absolute
 * path**, and this is where an incoming request is held to that. It runs before
 * anything is enqueued, because the alternative is discovering a bad path after
 * 800 MB, at the move.
 *
 * ⚠️ This checks the *string*, not the filesystem. The worker still resolves and
 * re-checks against the real root before writing: a rule enforced only at the
 * edge is a rule that a second entry point can walk past.
 */
import { Result } from "better-result";
import { PathOutsideRoot } from "../core/errors";

/** Windows reserved device names — `filenamify` knows them; a raw path does not. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Normalise a destination, or refuse it.
 *
 * Accepts `""` for the library root. Everything else must be a relative path of
 * plain segments: no leading slash, no `..`, no drive letter, no backslashes,
 * no `.` segments left over.
 */
export function safeDestination(input: string, root = "/library"): Result<string, PathOutsideRoot> {
  const raw = input.trim();
  if (raw === "" || raw === "." || raw === "/") return Result.ok("");

  const refuse = (): Result<string, PathOutsideRoot> =>
    Result.err(new PathOutsideRoot({ path: input, root }));

  // Backslashes are separators on the platforms that use them, so a path that
  // looks harmless here could climb out there. Refuse rather than translate.
  if (raw.includes("\\") || raw.includes("\0")) return refuse();
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) return refuse();

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return refuse();
    // A trailing dot or space disappears on Windows and turns `a.` into `a`,
    // which is a different folder from the one that was asked for.
    if (/[. ]$/.test(segment)) return refuse();
    if (RESERVED.test(segment)) return refuse();
    segments.push(segment);
  }

  return Result.ok(segments.join("/"));
}
