/**
 * A failure as a sentence first, with the downloader's own text one click away.
 *
 * 📌 The raw text stays reachable on purpose: it is what a bug report needs,
 * and an explanation that turned out wrong must not have eaten the evidence.
 * See `core/explain.ts` for which failures get a sentence and why the rest do
 * not.
 */
import { explainFailure } from "../../../core/explain";

export function ExplainedError({
  text,
  url,
  sentence,
  className,
}: {
  /** The original failure text. */
  text: string;
  /** The link that failed, so the sentence can name its site. */
  url?: string;
  /** A sentence already worked out (the server sends one with API errors). */
  sentence?: string;
  className?: string;
}) {
  const said = sentence ?? explainFailure(text, url);
  if (said === null || said === text) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {said}
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">Technical detail</summary>
        <span className="mt-1 block font-mono text-[11px] break-words">{text}</span>
      </details>
    </span>
  );
}
