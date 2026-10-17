// The side panel's thread view: anchor quote, the thread's messages, composer.
import { lineLabel, type LineAnchor, type Location } from '@shared/review'
import type { Attachment, SessionLive, Thread } from '@shared/types'
import { threadTag } from '@shared/wire'
import type { OpenSession, Panel } from './App'
import { itemSource, listItemSpans } from './anchors'
import { KIND_NAMES, kindOf } from './reviewThreads'
import { Composer, type ComposerQueue } from './Composer'
import { ExportMenu } from './ExportMenu'
import { Log, logItems, type Notice, type Reveal } from './Log'
import { Markdown } from './Markdown'

type Props = {
  /** Width the user dragged it to; null = the CSS default. */
  width: number | null
  open: OpenSession
  panel: Panel
  reveal: Reveal | null
  /** The overview tab ← goes back to. */
  backTo: 'threads' | 'queue'
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  notices: Notice[]
  live: SessionLive
  /** Messages sent in every session, newest first, for the composer's Up and Down. */
  history: string[]
  /** Messages queued from this thread. */
  queue: ComposerQueue
  onSend(text: string, attachments: Attachment[]): void
  /** Sends the message to the main conversation, tagged as continuing this thread (SPEC → Send to main). */
  onSendToMain(text: string, attachments: Attachment[]): void
  /** Injects the message into the running turn (when it runs in this thread). */
  onSteer(text: string, attachments: Attachment[]): void
  onCancel(): void
  /** Back to the threads overview. */
  onBack(): void
  /** Collapses the side panel. */
  onClose(): void
  onCopyMarkdown(threadId: string): void
  onSaveMarkdown(threadId: string): void
  /** Scrolls the main conversation to the thread's anchor; absent when it isn't shown there. */
  onFindInMain?(): void
  /** A line thread's place in the review's diff now (SPEC → Review sessions). */
  location?: Location
  /** Resolves or reopens a line thread. */
  onResolve?(threadId: string, resolved: boolean): void
}

const findIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
)

export function ThreadPanel(props: Props): React.JSX.Element {
  const { open, panel, runningThread, notices, live, onSend, onCancel, onClose } = props
  const threadId = panel.threadId
  const running = runningThread !== undefined
  const runningHere = running && panel.threadId !== null && runningThread === panel.threadId
  if (panel.anchor.kind === 'line') {
    const thread = threadId === null ? undefined : open.threads.find((t) => t.id === threadId)
    return <LineThreadPanel {...props} anchor={panel.anchor} thread={thread} running={running} runningHere={runningHere} />
  }

  // Quote a list item as rendered markdown when it can be found; a selection
  // (which may cut through markup) as its plain text.
  const anchorMessage = open.messages.find((m) => m.id === panel.anchorMessageId)
  let quote = panel.anchor.kind === 'selection' ? `“${panel.anchor.text}”` : panel.anchor.text
  if (anchorMessage && panel.anchor.kind === 'listItem') {
    const span = listItemSpans(anchorMessage.text)[panel.anchor.path[0]]
    if (span) quote = itemSource(anchorMessage.text, span)
  }
  const isSelection = panel.anchor.kind === 'selection'

  return (
    <aside
      className="thread-panel"
      aria-label="Thread"
      style={props.width === null ? undefined : { flexBasis: props.width }}
    >
      <header>
        <button className="back" onClick={props.onBack}>
          {props.backTo === 'queue' ? '← Queue' : '← All threads'}
        </button>
        {threadId === null && <h2 className="thread-label">New thread</h2>}
        {runningHere && <span className="status">Agent is working…</span>}
        {props.onFindInMain && (
          <button className="header-button icon find-in-main" onClick={props.onFindInMain} title="Find in main session" aria-label="Find in main session">
            {findIcon}
          </button>
        )}
        {/* Shown before the thread exists too, so the header's buttons don't move. */}
        <ExportMenu
          label="thread"
          disabled={threadId === null}
          onCopy={() => threadId !== null && props.onCopyMarkdown(threadId)}
          onSave={() => threadId !== null && props.onSaveMarkdown(threadId)}
        />
        <button className="close" onClick={onClose} aria-label="Hide panel" title="Hide panel (Ctrl+Shift+T)">
          »
        </button>
      </header>
      <blockquote className="anchor-quote">
        {isSelection ? <p className="selection-quote">{quote}</p> : <Markdown text={quote} />}
      </blockquote>
      <Log
        className="thread-log"
        items={panel.threadId === null ? [] : logItems(open, notices, panel.threadId)}
        empty={
          <p className="muted empty">
            No replies yet. Your first message starts a thread on this {isSelection ? 'selection' : 'item'}.
          </p>
        }
        renderAgent={(m) => <Markdown text={m.text} />}
        reveal={props.reveal}
      />
      <Composer
        key={`${panel.anchorMessageId}:${JSON.stringify(panel.anchor)}`}
        draftKey={`${open.session.id}:${panel.anchorMessageId}:${JSON.stringify(panel.anchor)}`}
        className="thread-composer"
        placeholder="Reply in thread"
        running={running}
        autoFocus
        primary
        commands={live.commands}
        accepts={live.accepts}
        history={props.history}
        queue={props.queue}
        onSend={onSend}
        onSteer={live.steering && runningHere ? props.onSteer : undefined}
        onCancel={runningHere ? onCancel : undefined}
        // A thread that doesn't exist yet has nothing to continue.
        onSendToMain={threadId !== null ? props.onSendToMain : undefined}
        footer={<div className="mono wire">sent as: {threadTag(panel.anchor)} …</div>}
      />
    </aside>
  )
}

/** A review thread on diff lines: its lines, the agent's finding, and Resolve. */
function LineThreadPanel(
  props: Props & { anchor: LineAnchor; thread: Thread | undefined; running: boolean; runningHere: boolean }
): React.JSX.Element {
  const { open, panel, anchor, thread, live, location } = props
  const threadId = panel.threadId
  const outdated = location?.kind === 'outdated' || location?.kind === 'gone'
  const first = location?.kind === 'found' ? location.start : anchor.start
  const kind = thread ? kindOf(thread) : 'you'
  const resolved = thread?.resolvedAt !== undefined
  return (
    <aside className="thread-panel line-thread" aria-label="Thread" style={props.width === null ? undefined : { flexBasis: props.width }}>
      <header>
        <button className="back" onClick={props.onBack}>
          {props.backTo === 'queue' ? '← Queue' : '← All threads'}
        </button>
        <span className={`kind-chip kind-${kind}`}>{KIND_NAMES[kind]}</span>
        <span className="mono thread-lines" title={lineLabel(anchor)}>
          {anchor.end === anchor.start ? `L${first}` : `L${first}–${first + anchor.end - anchor.start}`}
          {anchor.side === 'old' ? ' (old)' : ''}
        </span>
        {threadId === null && <h2 className="thread-label">New thread</h2>}
        {props.runningHere && <span className="status">Agent is working…</span>}
        {thread && props.onResolve && (
          <button className="resolve" onClick={() => props.onResolve?.(thread.id, !resolved)}>
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
        <ExportMenu
          label="thread"
          disabled={threadId === null}
          onCopy={() => threadId !== null && props.onCopyMarkdown(threadId)}
          onSave={() => threadId !== null && props.onSaveMarkdown(threadId)}
        />
        <button className="close" onClick={props.onClose} aria-label="Hide panel" title="Hide panel (Ctrl+Shift+T)">
          »
        </button>
      </header>
      <div className="line-quote">
        <div className="line-quote-head">
          <span className="mono">{anchor.file}</span>
          {location?.kind === 'outdated' && <span className="tag-outdated">Outdated: these lines changed</span>}
          {location?.kind === 'gone' && <span className="tag-outdated">No longer changed</span>}
          {resolved && <span className="tag-resolved">Resolved</span>}
        </div>
        <pre className={outdated ? 'gone' : undefined}>
          {anchor.lines.map((l, i) => (
            <span key={i} className="line-quote-row">
              <span className="line-quote-num">{(outdated ? anchor.start : first) + i}</span>
              {l || ' '}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
      {thread?.finding && (
        <div className="finding">
          <b>{thread.finding.title}</b>
          {thread.finding.body && <Markdown text={thread.finding.body} />}
        </div>
      )}
      <Log
        className="thread-log"
        items={threadId === null ? [] : logItems(open, props.notices, threadId)}
        empty={
          thread?.finding ? null : <p className="muted empty">No replies yet. Your first message starts a thread on these lines.</p>
        }
        renderAgent={(m) => <Markdown text={m.text} />}
        reveal={props.reveal}
      />
      <Composer
        key={`${open.session.id}:${JSON.stringify(panel.anchor)}`}
        draftKey={`${open.session.id}:line:${JSON.stringify(panel.anchor)}`}
        className="thread-composer"
        placeholder="Reply in thread"
        running={props.running}
        autoFocus
        primary
        commands={live.commands}
        accepts={live.accepts}
        history={props.history}
        queue={props.queue}
        onSend={props.onSend}
        onSteer={live.steering && props.runningHere ? props.onSteer : undefined}
        onCancel={props.runningHere ? props.onCancel : undefined}
        onSendToMain={threadId !== null ? props.onSendToMain : undefined}
        footer={<div className="mono wire">sent as: {threadTag(panel.anchor)} …</div>}
      />
    </aside>
  )
}
