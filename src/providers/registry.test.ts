import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import type { Provider } from "../core/types";
import { createDefaultRegistry, createRegistry } from "./registry";

function stub(name: string, supports: (url: string) => boolean): Provider {
  return {
    name,
    supports,
    probe: async () => {
      throw new Error("not used");
    },
    fetch: async () => {
      throw new Error("not used");
    },
  };
}

const catchAll = stub("yt-dlp", () => true);
const vimeo = stub("vimeo", (url) => url.includes("vimeo.com"));
const anotherVimeo = stub("vimeo-2", (url) => url.includes("vimeo.com"));

describe("registration order", () => {
  test("the fallback is asked last, however many providers arrive", () => {
    const registry = createRegistry({ fallback: catchAll });
    registry.register(vimeo);
    registry.register(anotherVimeo);
    expect(registry.providers().map((p) => p.name)).toEqual(["vimeo", "vimeo-2", "yt-dlp"]);
  });

  test("providers passed at construction keep their order, still ahead of the fallback", () => {
    const registry = createRegistry({ fallback: catchAll, providers: [vimeo] });
    registry.register(anotherVimeo);
    expect(registry.providers().map((p) => p.name)).toEqual(["vimeo", "vimeo-2", "yt-dlp"]);
  });

  test("a specific provider wins over the catch-all for a URL both claim", () => {
    const registry = createRegistry({ fallback: catchAll });
    registry.register(vimeo);
    const resolved = registry.resolve("https://vimeo.com/123");
    expect(Result.isOk(resolved) && resolved.value.name).toBe("vimeo");
  });

  test("first registered wins when two providers claim the same URL", () => {
    const registry = createRegistry({ fallback: catchAll });
    registry.register(vimeo);
    registry.register(anotherVimeo);
    const resolved = registry.resolve("https://vimeo.com/123");
    expect(Result.isOk(resolved) && resolved.value.name).toBe("vimeo");
  });

  test("anything nobody claims falls through to the catch-all", () => {
    const registry = createRegistry({ fallback: catchAll });
    registry.register(vimeo);
    const resolved = registry.resolve("https://example.com/watch/1");
    expect(Result.isOk(resolved) && resolved.value.name).toBe("yt-dlp");
  });
});

describe("nothing claims the URL", () => {
  test("resolve returns UnsupportedUrl carrying the URL", () => {
    // Unreachable while yt-dlp is present — it answers for everything. The
    // error exists because the type demands it, and because a registry without
    // the built-in has to refuse clearly rather than half-attempt (PLAN §5).
    const registry = createRegistry({ fallback: null });
    registry.register(vimeo);
    const resolved = registry.resolve("https://example.com/watch/1");
    expect(Result.isError(resolved)).toBe(true);
    expect(Result.isError(resolved) && resolved.error._tag).toBe("UnsupportedUrl");
    expect(Result.isError(resolved) && resolved.error.url).toBe("https://example.com/watch/1");
  });

  test("an empty registry refuses everything", () => {
    const registry = createRegistry();
    expect(registry.providers()).toEqual([]);
    expect(Result.isError(registry.resolve("https://vimeo.com/1"))).toBe(true);
  });
});

test("a provider whose supports() throws loses its turn instead of the URL", () => {
  // Providers arrive from plugin files the user dropped in DATA_DIR. A bug in
  // one of them must not make every URL unresolvable.
  const broken = stub("broken", () => {
    throw new Error("plugin bug");
  });
  const registry = createRegistry({ fallback: catchAll });
  registry.register(broken);
  registry.register(vimeo);
  const resolved = registry.resolve("https://vimeo.com/123");
  expect(Result.isOk(resolved) && resolved.value.name).toBe("vimeo");
});

test("providers() returns a copy, so callers cannot reorder the registry", () => {
  const registry = createRegistry({ fallback: catchAll });
  registry.register(vimeo);
  const list = registry.providers();
  list.reverse();
  expect(registry.providers().map((p) => p.name)).toEqual(["vimeo", "yt-dlp"]);
});

describe("the default registry", () => {
  test("ships with yt-dlp last and claiming everything", () => {
    const registry = createDefaultRegistry();
    expect(registry.providers().map((p) => p.name)).toEqual(["yt-dlp"]);
    const resolved = registry.resolve("https://some.site.example/v/1");
    expect(Result.isOk(resolved) && resolved.value.name).toBe("yt-dlp");
  });

  test("registering keeps yt-dlp at the back — it cannot be displaced", () => {
    const registry = createDefaultRegistry();
    registry.register(vimeo);
    registry.register(anotherVimeo);
    expect(registry.providers().at(-1)?.name).toBe("yt-dlp");
    expect(Result.isOk(registry.resolve("https://vimeo.com/1"))).toBe(true);
  });
});
