// The side panel's thread view: anchor quote, the thread's messages, composer.
import { lineLabel, type LineAnchor, type Location } from '@shared/review'
import type { Attachment, Message, SessionLive, Thread } from '@shared/types'
import { threadTag } from '@shared/wire'
import type { OpenSession, Panel } from './App'
import { itemSource, listItemSpans } from './anchors'
import { KIND_NAMES, kindOf } from './reviewThreads'
import { Composer, type ComposerQueue } from './Composer'
import { ExportMenu } from './ExportMenu'
import { Log, logItems, TurnStatus, type Notice, type Reveal } from './Log'
import { Markdown } from './Markdown'
import { PinCrop, pinAnchorsFor } from './CaptureFigure'
import { ArrowLeft, Locate, PanelRight } from 'lucide-react'

type Props = {
  agentName: string
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
  /** Opens the thread on a pin of an annotated screenshot in this thread's messages. */
  onOpenPin(message: Message, image: number, pin: number): void
  onCopyMarkdown(threadId: string): void
  onSaveMarkdown(threadId: string): void
  /** Scrolls the main conversation to the thread's anchor; absent when it isn't shown there. */
  onFindInMain?(): void
  onRevealMain(message: Message): void
  /** A line thread's place in the review's diff now (SPEC → Review sessions). */
  location?: Location
  /** Resolves or reopens a line thread. */
  onResolve?(threadId: string, resolved: boolean): void
}

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
  const pin = panel.anchor.kind === 'pin' ? panel.anchor : null
  const pinImage = pin ? anchorMessage?.attachments?.[pin.image] : undefined

  return (
    <aside
      className="thread-panel"
      aria-label="Thread"
      style={props.width === null ? undefined : { flexBasis: props.width }}
    >
      <header>
        <button className="back" onClick={props.onBack}>
          <ArrowLeft />
          {props.backTo === 'queue' ? 'Queue' : 'All threads'}
        </button>
        {threadId === null && <h2 className="thread-label">New thread</h2>}
        {runningHere && <TurnStatus open={open} threadId={threadId} />}
        {props.onFindInMain && (
          <button className="header-button icon find-in-main" onClick={props.onFindInMain} title="Find in main session" aria-label="Find in main session">
            <Locate />
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
          <PanelRight />
        </button>
      </header>
      <blockquote className={pin ? 'anchor-quote pin-quote' : 'anchor-quote'} title={`Sent to the agent as ${threadTag(panel.anchor)} …`}>
        {pin ? (
          <>
            {pinImage?.kind === 'image' && <PinCrop image={pinImage} pin={pin.pin} />}
            <span className="pin-quote-text">
              <b>
                <span className="pin-number">{pin.pin}</span>
                {pin.note || 'No note'}
              </b>
              <span className="muted">Pin {pin.pin} in your screenshot</span>
            </span>
          </>
        ) : isSelection ? (
          <p className="selection-quote">{quote}</p>
        ) : (
          <Markdown text={quote} />
        )}
      </blockquote>
      <Log
        cwd={open.session.cwd}
        className="thread-log"
        scrollKey={panel.threadId === null ? undefined : `${open.session.id}:thread:${panel.threadId}`}
        items={panel.threadId === null ? [] : logItems(open, notices, panel.threadId)}
        empty={
          <p className="muted empty">
            No replies yet. Your first message starts a thread on this {pin ? 'pin' : isSelection ? 'selection' : 'item'}.
          </p>
        }
        renderAgent={(m) => <Markdown text={m.text} />}
        onRevealMain={props.onRevealMain}
        reveal={props.reveal}
        pins={pinAnchorsFor(open, panel, runningThread, props.onOpenPin)}
        footer={<>
          <Composer
            sessionId={open.session.id}
            agent={{ id: open.session.agentId, name: props.agentName }}
            key={`${panel.anchorMessageId}:${JSON.stringify(panel.anchor)}`}
            draftKey={`${open.session.id}:${panel.anchorMessageId}:${JSON.stringify(panel.anchor)}`}
            className="thread-composer"
            placeholder={pin ? `Reply about pin ${pin.pin}` : 'Reply in thread'}
            running={running}
            autoFocus
            primary
            commands={live.commands}
            accepts={live.accepts}
            history={props.history}
            queue={props.queue}
            onSend={onSend}
            onSteer={live.steering && runningHere ? props.onSteer : undefined}
            onInterrupt={props.onCancel}
            onCancel={runningHere ? onCancel : undefined}
            // A thread that doesn't exist yet has nothing to continue.
            onSendToMain={threadId !== null ? props.onSendToMain : undefined}
          />
        </>}
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
          <ArrowLeft />
          {props.backTo === 'queue' ? 'Queue' : 'All threads'}
        </button>
        <span className={`kind-chip kind-${kind}`}>{KIND_NAMES[kind]}</span>
        <span className="thread-lines" title={lineLabel(anchor)}>
          {anchor.end === anchor.start ? `L${first}` : `L${first}–${first + anchor.end - anchor.start}`}
          {anchor.side === 'old' ? ' (old)' : ''}
        </span>
        {threadId === null && <h2 className="thread-label">New thread</h2>}
        {props.runningHere && <TurnStatus open={open} threadId={threadId} />}
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
          <PanelRight />
        </button>
      </header>
      <div className="line-quote" title={`Sent to the agent as ${threadTag(panel.anchor)} …`}>
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
        cwd={open.session.cwd}
        className="thread-log"
        scrollKey={threadId === null ? undefined : `${open.session.id}:thread:${threadId}`}
        items={threadId === null ? [] : logItems(open, props.notices, threadId)}
        empty={
          thread?.finding ? null : <p className="muted empty">No replies yet. Your first message starts a thread on these lines.</p>
        }
        renderAgent={(m) => <Markdown text={m.text} />}
        onRevealMain={props.onRevealMain}
        reveal={props.reveal}
        footer={<>
          <Composer
            sessionId={open.session.id}
            agent={{ id: open.session.agentId, name: props.agentName }}
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
            onInterrupt={props.onCancel}
            onCancel={props.runningHere ? props.onCancel : undefined}
            onSendToMain={threadId !== null ? props.onSendToMain : undefined}
          />
        </>}
      />
    </aside>
  )
}
