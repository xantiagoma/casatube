/**
 * Every cache key in one file.
 *
 * Keys are the contract between whatever writes the cache and whatever reads
 * it — the SSE stream pushes into `jobs`, a mutation invalidates `library`, a
 * screen reads both. Scattering the literals is how two of them end up one
 * character apart and nothing ever refreshes.
 */
export const keys = {
  health: ["health"] as const,
  jobs: ["jobs"] as const,
  jobDefaults: ["jobs", "defaults"] as const,
  destinations: ["destinations"] as const,
  probe: (url: string) => ["probe", url] as const,

  library: (query: Record<string, unknown>) => ["library", query] as const,
  libraryItem: (path: string, probe: boolean) => ["library", "item", path, probe] as const,
  /** The server's playback verdict for one file. Asking has no side effects. */
  libraryPlayback: (path: string) => ["library", "playback", path] as const,
  trash: ["library", "trash"] as const,

  sources: ["sources"] as const,
  source: (id: string) => ["sources", id] as const,
  scheduler: ["scheduler"] as const,

  storage: ["stats", "storage"] as const,
  analytics: (range: string) => ["stats", "analytics", range] as const,

  notifications: (unreadOnly: boolean) => ["notifications", unreadOnly] as const,
  plugins: ["plugins"] as const,
  pluginDocs: ["plugins", "docs"] as const,
  pluginTemplate: ["plugins", "template"] as const,
  /** Keyed on the **filename**, because that is what the editor opens — see `data/plugins.ts`. */
  pluginSource: (file: string) => ["plugins", "source", file] as const,
  pluginSettings: (name: string) => ["plugins", "settings", name] as const,
} as const;
