/**
 * The whole screen: a form, and the queue.
 *
 * Deliberately one page. The router and the ten screens PLAN §8 describes come
 * later; what has to be true first is that a URL goes in and the queue can be
 * watched moving, because that is the thing the project exists to do.
 */
import { AddJobForm } from "./AddJobForm";
import { QueueList } from "./QueueList";
import { useQueue } from "../data/useQueue";
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
  const queue = useQueue();
  const { theme, cycle } = useTheme();

  return (
    <div className="shell">
      <header className="header">
        <h1>CasaTube</h1>
        <div className="spacer" />
        <span className={`conn ${queue.connection}`} title={queue.problem ?? undefined}>
          <span className="dot" />
          {CONNECTION_LABEL[queue.connection] ?? queue.connection}
        </span>
        <button type="button" className="small" onClick={cycle}>
          {THEME_LABEL[theme]}
        </button>
        <p className="tagline">
          The browser only watches. Downloads run on the server and survive this tab closing.
        </p>
      </header>

      <AddJobForm />

      {queue.connection === "reconnecting" && (
        <div className="note warn">
          Lost the connection to the server. Retrying — nothing in the queue is affected.
        </div>
      )}

      <QueueList jobs={queue.jobs} at={queue.at} connection={queue.connection} />
    </div>
  );
}
