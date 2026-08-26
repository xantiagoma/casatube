/**
 * The whole screen: a form, and the queue.
 *
 * Deliberately one page. The router and the ten screens PLAN §8 describes come
 * later; what has to be true first is that a URL goes in and the queue can be
 * watched moving, because that is the thing the project exists to do.
 *
 * Note the shape of the two hooks: `useJobStream` pushes into the cache and
 * reports only whether it is connected, and `useJobs` reads that cache and
 * polls when it is not. Neither owns the other.
 */
import { AddJobForm } from "./AddJobForm";
import { QueueList } from "./QueueList";
import { useJobs } from "../data/queries";
import { useJobStream } from "../data/stream";
import { useTheme } from "./useTheme";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

const THEME_LABEL: Record<string, string> = {
  system: "Theme: system",
  light: "Theme: light",
  dark: "Theme: dark",
};

export function App(): React.JSX.Element {
  const { connection, problem } = useJobStream();
  const query = useJobs(connection === "live");
  const { theme, cycle } = useTheme();

  return (
    <div className="shell">
      <header className="header">
        <h1>CasaTube</h1>
        <div className="spacer" />
        <span className={`conn ${connection}`} title={problem ?? undefined}>
          <span className="dot" />
          {CONNECTION_LABEL[connection] ?? connection}
        </span>
        <button type="button" className="small" onClick={cycle}>
          {THEME_LABEL[theme]}
        </button>
        <p className="tagline">
          The browser only watches. Downloads run on the server and survive this tab closing.
        </p>
      </header>

      <AddJobForm />

      {connection === "reconnecting" && (
        <div className="note warn">
          Lost the live connection — falling back to refreshing every few seconds. Nothing in the queue is
          affected.
        </div>
      )}

      <QueueList query={query} connection={connection} />
    </div>
  );
}
