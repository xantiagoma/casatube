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
  /**
   * What became of each job's file, checked against the disk.
   *
   * 🔴 **Keyed on the ids asked about**, and deliberately *not* folded into
   * `jobs`. That entry is rewritten by the SSE stream twice a second; this one
   * costs a `stat` per row against a network mount and must be refetched when
   * somebody asks, not when a progress bar moves. Sorting the ids is what keeps
   * one set of jobs from producing two cache entries.
   */
  jobFileState: (ids: readonly string[]) => ["jobs", "file-state", [...ids].sort().join(",")] as const,
  destinations: ["destinations"] as const,
  probe: (url: string) => ["probe", url] as const,

  library: (query: Record<string, unknown>) => ["library", query] as const,
  libraryItem: (path: string, probe: boolean) => ["library", "item", path, probe] as const,
  /** The server's playback verdict for one file. Asking has no side effects. */
  libraryPlayback: (path: string) => ["library", "playback", path] as const,
  trash: ["library", "trash"] as const,

  /**
   * Conversions. Two keys, because they age at opposite rates: the preset list
   * is compiled into the server and never changes while a tab is open, and the
   * job list moves a percent at a time while an encode runs.
   *
   * ⚠️ **Not under `["library"]`.** A finished conversion invalidates that
   * whole prefix — there is a new file on disk — and a job list living beneath
   * it would cancel and refetch itself from inside the poll that reported the
   * finish.
   */
  transcodePresets: ["transcode", "presets"] as const,
  transcodes: ["transcode", "jobs"] as const,

  /**
   * The credential list. One key: the listing carries the encryption state and
   * the cookie notice with it, so a screen cannot render the rows while missing
   * the sentence that qualifies them.
   */
  credentials: ["credentials"] as const,

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
  /**
   * Which plugins would act on one URL.
   *
   * 🔴 Deliberately **under** the `plugins` prefix. The answer carries each
   * plugin's `state`, so switching one on in Settings changes what the download
   * window should be saying — and everything that toggles a plugin already
   * invalidates `["plugins"]`. Keying it outside that prefix would leave the
   * download window showing "off" for a plugin that is now on.
   */
  pluginsApplicable: (url: string) => ["plugins", "applicable", url] as const,

  /** Running HLS remuxes and the temp disk they hold. See `data/library.ts`. */
  hlsSessions: ["library", "hls", "sessions"] as const,

  /**
   * Application settings — **one** key for the whole snapshot.
   *
   * `restartPending` and the merged `preferences` are facts about the *set*: a
   * banner reading "two changes are waiting for a restart" cannot be assembled
   * from cache entries that each only know about themselves. See
   * `data/settings.ts`.
   */
  settings: ["settings"] as const,
} as const;
