// The side panel's overview of a session's threads, and the rail it collapses to
// (SPEC → Conversation view → Side panel).
import { useEffect } from "react";
import type { Thread } from "@shared/types";
import type { OpenSession } from "./App";
import { ago } from "./Sidebar";

export type ThreadSummary = {
  thread: Thread;
  replies: number;
  /** Its newest message's time, or the thread's creation for messages stored before M9. */
  lastActivity: number;
};

/** The session's threads with their reply counts, most recent activity first. */
export function threadSummaries(open: OpenSession): ThreadSummary[] {
  const byThread = new Map<string, ThreadSummary>(
    open.threads.map((t) => [
      t.id,
      { thread: t, replies: 0, lastActivity: t.createdAt },
    ]),
  );
  for (const m of open.messages) {
    const s = m.threadId === null ? undefined : byThread.get(m.threadId);
    if (!s) continue;
    s.replies++;
    if (m.createdAt !== undefined && m.createdAt > s.lastActivity)
      s.lastActivity = m.createdAt;
  }
  return [...byThread.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

const threadsIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

/** The collapsed side panel: a threads button with the count and a running dot. */
export function SideRail(props: {
  count: number;
  running: boolean;
  onExpand(): void;
}): React.JSX.Element {
  return (
    <div className="side-rail">
      <button
        className="rail-button"
        onClick={props.onExpand}
        title="Threads (Ctrl+Shift+T)"
        aria-label={`Show threads (${props.count})`}
      >
        {threadsIcon}
        <span className="rail-count">{props.count}</span>
        {props.running && <span className="running-dot" aria-label="Running" />}
      </button>
    </div>
  );
}

type Props = {
  /** Width the user dragged the panel to; null = the CSS default. */
  width: number | null;
  open: OpenSession;
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined;
  /** "item 2", or "selection". */
  label(thread: Thread): string;
  onOpenThread(threadId: string): void;
  onCollapse(): void;
};

export function ThreadsOverview(props: Props): React.JSX.Element {
  const { onCollapse } = props;
  const summaries = threadSummaries(props.open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCollapse]);

  return (
    <aside
      className="thread-panel threads-overview"
      aria-label="Threads"
      style={props.width === null ? undefined : { flexBasis: props.width }}
    >
      <header>
        <h2>Threads</h2>
        <span className="mono">{summaries.length}</span>
        <button
          className="close"
          onClick={onCollapse}
          aria-label="Hide panel"
          title="Hide panel (Esc)"
        >
          »
        </button>
      </header>
      <div className="thread-list">
        {summaries.length === 0 && (
          <p className="muted empty">
            No threads yet. Reply to a list item, or select text in an agent
            message, to start one.
          </p>
        )}
        {summaries.map(({ thread, replies, lastActivity }) => {
          const running = props.runningThread === thread.id;
          return (
            <button
              key={thread.id}
              className="thread-row"
              onClick={() => props.onOpenThread(thread.id)}
            >
              <span className="mono">{props.label(thread)}</span>
              <span className="thread-quote">
                {thread.anchor.kind === "selection"
                  ? `“${thread.anchor.text}”`
                  : thread.anchor.text}
              </span>
              <span className="thread-meta">
                <span>
                  {replies} {replies === 1 ? "reply" : "replies"}
                </span>
                <span title={new Date(lastActivity).toLocaleString()}>
                  {ago(lastActivity) === "now"
                    ? "just now"
                    : `${ago(lastActivity)} ago`}
                </span>
                {running && (
                  <span className="thread-working">
                    <span className="running-dot" aria-hidden />
                    working
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
