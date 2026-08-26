/**
 * The provider registry.
 *
 * One rule decides everything here: **yt-dlp answers last**. It claims every
 * URL, so anything registered after it would never be asked. Providers added by
 * plugins go in front, in registration order, which is what makes a custom
 * extractor possible for a site yt-dlp covers badly (PLAN §5).
 */
import { Result } from "better-result";
import { UnsupportedUrl } from "../core/errors";
import type { Provider } from "../core/types";
import { createYtdlpProvider, type YtdlpOptions } from "./ytdlp";

export interface ProviderRegistry {
  /** Adds a provider ahead of the fallback, behind everything already added. */
  register(provider: Provider): void;
  /** The order URLs are actually offered in — fallback last. */
  providers(): Provider[];
  /** First provider that claims the URL. */
  resolve(url: string): Result<Provider, UnsupportedUrl>;
}

export interface RegistryOptions {
  /**
   * The provider asked last, after every registered one. Pass `null` for a
   * registry with no catch-all — the only way `resolve` can return
   * `UnsupportedUrl`, and the reason that error exists at all.
   */
  fallback?: Provider | null;
  /** Registered ahead of the fallback, in the order given. */
  providers?: Provider[];
}

export function createRegistry(options: RegistryOptions = {}): ProviderRegistry {
  const registered: Provider[] = [...(options.providers ?? [])];
  const fallback = options.fallback === undefined ? null : options.fallback;

  const providers = (): Provider[] =>
    fallback ? [...registered, fallback] : [...registered];

  return {
    register(provider: Provider): void {
      registered.push(provider);
    },

    providers,

    resolve(url: string): Result<Provider, UnsupportedUrl> {
      for (const provider of providers()) {
        // A provider can arrive from a plugin file the user dropped in
        // DATA_DIR. A throw in its `supports` is that plugin's bug, not a
        // reason to refuse the URL for everyone — so it loses its turn and the
        // next provider is asked.
        let claims = false;
        try {
          claims = provider.supports(url);
        } catch {
          claims = false;
        }
        if (claims) return Result.ok(provider);
      }
      return Result.err(new UnsupportedUrl({ url }));
    },
  };
}

/**
 * The registry the application runs with: nothing registered yet, yt-dlp
 * waiting at the back. It cannot be removed — `register` only ever inserts in
 * front of it.
 */
export function createDefaultRegistry(options: YtdlpOptions = {}): ProviderRegistry {
  return createRegistry({ fallback: createYtdlpProvider(options) });
}
