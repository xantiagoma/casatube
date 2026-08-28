/**
 * `GET`/`POST /api/destinations`, against a **real directory tree**.
 *
 * A mocked filesystem would prove nothing here: the whole point of the route is
 * what the disk actually contains, and the interesting cases — a file that is
 * not a folder, a hidden folder, a root that is not there at all — are
 * distinctions the real `readdir` makes and a stub would have to imitate.
 *
 * The context is a cast rather than a whole application: this route reads
 * `config` and touches nothing else, and opening two SQLite files to list a
 * directory would make the test slower and less specific, not more honest.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { destinationRoutes } from "./destinations";

let root: string;

function appFor(libraryDir: string) {
  const ctx = { config: { ...loadConfig({}), libraryDir } } as AppContext;
  return new Elysia({ prefix: "/api" }).use(destinationRoutes(ctx));
}

type Listing = { root: string; folders: { path: string; name: string; depth: number }[]; truncated: boolean };

async function list(libraryDir: string): Promise<Response> {
  return appFor(libraryDir).handle(new Request("http://local/api/destinations"));
}

async function create(libraryDir: string, path: unknown): Promise<Response> {
  return appFor(libraryDir).handle(
    new Request("http://local/api/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-library-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface NameCheck {
  name: string;
  taken: boolean;
  suggestion: string;
  using: string[];
  destination: string;
}

async function nameCheck(libraryDir: string, destination: string, name: string): Promise<Response> {
  const query = new URLSearchParams({ destination, name });
  return appFor(libraryDir).handle(new Request(`http://local/api/destinations/name-check?${query}`));
}

describe("GET /api/destinations/name-check", () => {
  test("a free name comes back free, in a folder that does not exist yet", async () => {
    // Not a failure: the move stage creates the folder. Reporting it as an
    // error would make an ordinary first download look broken.
    const body = (await (await nameCheck(root, "Talks", "A Talk")).json()) as NameCheck;
    expect(body).toMatchObject({ name: "A Talk", taken: false, suggestion: "A Talk", using: [] });
  });

  test("🔴 a taken name says what is using it, and what to use instead", async () => {
    mkdirSync(join(root, "Talks"));
    writeFileSync(join(root, "Talks", "A Talk.mkv"), "video");
    writeFileSync(join(root, "Talks", "A Talk.en.srt"), "subs");

    const body = (await (await nameCheck(root, "Talks", "A Talk")).json()) as NameCheck;
    expect(body.taken).toBe(true);
    expect(body.suggestion).toBe("A Talk (2)");
    // Named, not counted: "2 files" is something to go and decode.
    expect(body.using.sort()).toEqual(["A Talk.en.srt", "A Talk.mkv"]);
  });

  test("🔴 a lone sidecar takes the name too", async () => {
    mkdirSync(join(root, "Talks"));
    writeFileSync(join(root, "Talks", "A Talk.en.srt"), "subs");

    const body = (await (await nameCheck(root, "Talks", "A Talk")).json()) as NameCheck;
    expect(body.taken).toBe(true);
    expect(body.using).toEqual(["A Talk.en.srt"]);
  });

  test("🔴 the answer is the cleaned name, so a slash cannot look like a folder", async () => {
    const body = (await (await nameCheck(root, "", "../etc/passwd")).json()) as NameCheck;
    expect(body.name).not.toContain("/");
    expect(body.taken).toBe(false);
  });

  test("a destination that escapes the library is refused", async () => {
    const response = await nameCheck(root, "../escaped", "A Talk");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { tag: string }).tag).toBe("PathOutsideRoot");
  });

  test("🔴 a library that cannot be read is not reported as free", async () => {
    // "The folder is not there" and "the folder could not be read" are
    // different answers. Collapsing them would tell the form a name is free
    // because nothing could look — and the download would land beside a file
    // nobody could see.
    const file = join(root, "not-a-folder");
    writeFileSync(file, "this is a file");
    const response = await nameCheck(root, "not-a-folder", "A Talk");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { tag: string }).tag).toBe("MountUnavailable");
  });
});

describe("GET /api/destinations", () => {
  test("lists the folders that exist, two levels deep", async () => {
    mkdirSync(join(root, "youtube", "talks"), { recursive: true });
    mkdirSync(join(root, "youtube", "music"), { recursive: true });
    mkdirSync(join(root, "films"), { recursive: true });
    // Deeper than the walk goes — present on disk, absent from the listing.
    mkdirSync(join(root, "youtube", "talks", "2026"), { recursive: true });

    const response = await list(root);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Listing;

    expect(body.folders.map((f) => f.path)).toEqual(["films", "youtube", "youtube/music", "youtube/talks"]);
    expect(body.folders.find((f) => f.path === "youtube/talks")?.depth).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.root).toBe(root);
  });

  test("an empty library is an empty list, not an error", async () => {
    const response = await list(root);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Listing).folders).toEqual([]);
  });

  test("files are not destinations, and hidden folders are not offered", async () => {
    writeFileSync(join(root, "a-video.mkv"), "not a folder");
    mkdirSync(join(root, ".Trash-1000"));
    mkdirSync(join(root, "@eaDir"));
    mkdirSync(join(root, "keep"));

    const body = (await (await list(root)).json()) as Listing;
    expect(body.folders.map((f) => f.path)).toEqual(["keep"]);
  });

  test("a library that is not there answers 503, not 500", async () => {
    // What an unmounted share looks like from here. The tag matters more than
    // the message: the form reacts to it by falling back to a typed name.
    const response = await list(join(root, "nope", "gone"));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { tag: string }).tag).toBe("MountUnavailable");
  });
});

describe("POST /api/destinations", () => {
  test("creates a folder, and says so", async () => {
    const response = await create(root, "youtube/talks");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "youtube/talks", created: true });

    expect(((await (await list(root)).json()) as Listing).folders.map((f) => f.path)).toEqual([
      "youtube",
      "youtube/talks",
    ]);
  });

  test("creating one that already exists is not a failure", async () => {
    mkdirSync(join(root, "films"));
    expect(await (await create(root, "films")).json()).toEqual({ path: "films", created: false });
  });

  test("refuses a path that escapes the library, and writes nothing", async () => {
    const response = await create(root, "../escaped");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { tag: string }).tag).toBe("PathOutsideRoot");
    expect(((await (await list(root)).json()) as Listing).folders).toEqual([]);
  });

  test("the library root itself needs no creating", async () => {
    expect(await (await create(root, "  ")).json()).toEqual({ path: "", created: false });
  });
});
