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
  trash: ["library", "trash"] as const,

  sources: ["sources"] as const,
  source: (id: string) => ["sources", id] as const,
  scheduler: ["scheduler"] as const,

  storage: ["stats", "storage"] as const,
  analytics: (range: string) => ["stats", "analytics", range] as const,

  notifications: (unreadOnly: boolean) => ["notifications", unreadOnly] as const,
  plugins: ["plugins"] as const,
  pluginDocs: ["plugins", "docs"] as const,
} as const;
