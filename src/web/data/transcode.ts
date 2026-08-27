/**
 * Transcoding — the one thing CasaTube does that **re-encodes**.
 *
 * 🔴 Everything a screen needs to warn about comes from the server, and none of
 * it is written here. `GET /api/transcode/presets` carries a `cost` sentence per
 * preset and the `concurrency` number; `POST /api/transcode` carries a
 * `warning` and a per-file `rejected` reason. The UI quotes them. A second
 * wording of "this is expensive" living in the browser is a sentence free to
 * drift from the behaviour it describes — the same reason `core/transcode.ts`
 * puts the cost on the preset in the first place.
 *
 * ⚠️ **This list is polled, not pushed.** `/api/events` is the *download*
 * queue's stream and knows nothing about transcodes, so there is no frame to
 * push into this cache. The interval is therefore conditional: while something
 * is queued or running an encode moves a percent at a time and the list is worth
 * asking for every second and a half; with nothing active it is a page that
 * changes only when somebody presses a button, and 15 s is a courtesy refresh.
 *
 * 📌 If transcodes ever join the SSE stream, this is the file that changes and
 * nothing else: the components read the query, exactly as PLAN §8 requires.
 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { TranscodeRow } from "../../core/transcode";
import { api, unwrap } from "./client";
import { keys } from "./keys";

/**
 * A preset as the API describes it.
 *
 * ⚠️ Narrower than `TranscodePreset` in `core/transcode.ts`, on purpose: the
 * route does not send `args` (they are ffmpeg flags, and the whole point is
 * that no client ever sees or sends one) and it does not send `suffix`. So the
 * browser **cannot** predict the output filename, and nothing here pretends to
 * — the real `outputPath` arrives on the row once the job exists.
 */
export interface TranscodePresetInfo {
  id: string;
  label: string;
  description: string;
  /** 🔴 The server's own sentence about what this costs. Rendered verbatim. */
  cost: string;
  ext: string;
  /** `true` means the picture is decoded and made again; `false` is a copy or an audio pass. */
  reencodesVideo: boolean;
}

export interface TranscodePresetList {
  presets: TranscodePresetInfo[];
  /** 🔴 One. Sent by the server so a UI does not have to infer it. */
  concurrency: number;
}

export interface TranscodeListing {
  jobs: TranscodeRow[];
  /** The id of the job whose ffmpeg is alive right now, or `null`. */
  running: string | null;
}

export interface TranscodeOutcome {
  queued: TranscodeRow[];
  /** ⚠️ Partial success is the normal answer to a batch, not an error. */
  rejected: { path: string; reason: string }[];
  /** The server's warning, present only when something was actually queued. */
  warning?: string;
}

export interface StartTranscodeRequest {
  paths: string[];
  preset: string;
  /** ⚠️ Opt-in, and even then the original is *moved to `.trash/`* after the copy is verified. */
  replaceOriginal?: boolean;
}

/**
 * The presets.
 *
 * They are a fixed list compiled into the server, so they cannot change while
 * this tab is open — `staleTime: Infinity` rather than a number that means
 * "ask again for no reason".
 */
export function useTranscodePresets(enabled = true): UseQueryResult<TranscodePresetList, Error> {
  return useQuery({
    queryKey: keys.transcodePresets,
    queryFn: async () => unwrap(await api.api.transcode.presets.get()),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/** Whether anything is queued or running — the only thing the interval depends on. */
function hasActive(listing: TranscodeListing | undefined): boolean {
  return (listing?.jobs ?? []).some((job) => job.status === "queued" || job.status === "running");
}

export function useTranscodes(enabled = true): UseQueryResult<TranscodeListing, Error> {
  return useQuery({
    queryKey: keys.transcodes,
    queryFn: async () => unwrap(await api.api.transcode.get({ query: { limit: 100 } })),
    enabled,
    // See the note at the top: polled because there is no stream to push it.
    refetchInterval: (query) => (hasActive(query.state.data) ? 1_500 : 15_000),
    retry: 1,
  });
}

/**
 * Queue one file or many.
 *
 * ⚠️ Always sends `paths`, even for one file. The route accepts both and
 * answers `queued` + `rejected` either way, so a single code path here means
 * the dialog renders one shape of answer instead of two.
 */
export function useStartTranscode() {
  const client = useQueryClient();
  return useMutation<TranscodeOutcome, Error, StartTranscodeRequest>({
    mutationFn: async (request) =>
      unwrap(
        await api.api.transcode.post({
          paths: request.paths,
          preset: request.preset,
          ...(request.replaceOriginal === undefined ? {} : { replaceOriginal: request.replaceOriginal }),
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.transcodes });
    },
  });
}

/**
 * Cancel a queued job, or kill the running one.
 *
 * 🔴 Idempotent on the server, and that matters here: the list is a poll, so
 * the row a finger lands on may already have finished. Cancelling a finished
 * job answers with the row unchanged rather than an error to explain away.
 */
export function useCancelTranscode() {
  const client = useQueryClient();
  return useMutation<TranscodeRow, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.transcode({ id }).delete()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.transcodes });
    },
  });
}

/**
 * A finished conversion means a **new file on disk**, and the library listing
 * was fetched before it existed.
 *
 * ⚠️ Keyed on the *count* of finished jobs rather than on the array, which is a
 * new object on every poll: depending on the array would invalidate the library
 * every 1.5 s while an encode runs, which is a directory scan of a network
 * mount, twice a second, for nothing.
 */
export function useRefreshLibraryOnFinish(jobs: TranscodeRow[] | undefined): void {
  const client = useQueryClient();
  const finished = (jobs ?? []).filter((job) => job.status === "done").length;
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (jobs === undefined) return;
    if (seen.current !== null && finished > seen.current) {
      void client.invalidateQueries({ queryKey: ["library"] });
    }
    seen.current = finished;
    // `jobs` is deliberately absent: only the count is allowed to trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, client, jobs === undefined]);
}
