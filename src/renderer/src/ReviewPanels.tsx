// A review session's side panel (SPEC → Review sessions → Side panel): the threads by
// file with the general conversation pinned on top, and the general conversation itself.
import { useState } from 'react'
import { findingsBlocks, findingThread, isFirstPass, lineLabel, withoutFindings, type Location, type ReviewDiff } from '@shared/review'
import type { Attachment, Message, MessageQueue, SessionLive } from '@shared/types'
import { truncate } from '@shared/wire'
import type { OpenSession } from './App'
import { Composer, type ComposerQueue } from './Composer'
import { Log, logItems, type Notice, type Reveal } from './Log'
import { Markdown } from './Markdown'
import { inDiffOrder, KIND_NAMES, kindOf, shownLine, titleOf, type ThreadKind } from './reviewThreads'
import { ago } from './Sidebar'
import { threadSummaries } from './ThreadsOverview'
import { ArrowLeft, PanelRight } from 'lucide-react'
import { Check, ListFilter } from 'lucide-react'
import { Popover } from './Popover'

type Filter = 'open' | 'resolved' | 'all'
const KINDS: ThreadKind[] = ['bug', 'suggestion', 'nit', 'you']

/** The first pass as a status line in the general conversation. */
export function firstPassLine(m: Message): string | null {
  return isFirstPass(m.text) ? 'Gloss started the first pass: the agent is reviewing the diff.' : null
}

/** The Threads tab of a review session. */
export function ReviewThreadList(props: {
  open: OpenSession
  diff: ReviewDiff | null
  locations: Map<string, Location>
  runningThread: string | null | undefined
  queue: MessageQueue
  onOpenThread(threadId: string): void
  onOpenGeneral(): void
}): React.JSX.Element {
  const { open, locations } = props
  const [filter, setFilter] = useState<Filter>('open')
  const [kinds, setKinds] = useState<Set<ThreadKind>>(() => new Set(KINDS))
  const ordered = inDiffOrder(open.threads, props.diff, locations)
  const summaries = new Map(threadSummaries(open).map((s) => [s.thread.id, s]))
  const shown = ordered.filter(
    (t) => kinds.has(kindOf(t)) && (filter === 'all' || (filter === 'open') === (t.resolvedAt === undefined))
  )
  const counts = {
    open: ordered.filter((t) => t.resolvedAt === undefined).length,
    resolved: ordered.filter((t) => t.resolvedAt !== undefined).length,
    all: ordered.length
  }
  const main = open.messages.filter((m) => m.threadId === null && !(m.role === 'user' && isFirstPass(m.text)))
  const latest = [...main].reverse().find((m) => m.role === 'agent')
  const working = props.runningThread === null

  let lastFile: string | null = null
  return (
    <div className="thread-list review-threads">
      <button className="general-card" onClick={props.onOpenGeneral}>
        <span className="general-title">
          General conversation <span className="count">{main.length} {main.length === 1 ? 'message' : 'messages'}</span>
          {working && (
            <span className="thread-working">
              <span className="running-dot" aria-hidden />
              working
            </span>
          )}
        </span>
        <span className="general-latest">
          {latest ? truncate(withoutFindings(latest.text).replace(/[`*_#>]/g, ''), 160) : 'The agent’s summary of the change appears here.'}
        </span>
      </button>
      <div className="review-filters">
        <div className="segmented" role="group" aria-label="Show">
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : undefined} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)} <span className="count">{counts[f]}</span>
            </button>
          ))}
        </div>
        {/* One menu for the kinds of thread shown, rather than a chip each. */}
        <Popover
          down
          className="kind-menu-button"
          title="Kinds of thread shown"
          label={
            <>
              <ListFilter />
              {kinds.size === KINDS.length ? 'All kinds' : kinds.size === 0 ? 'No kinds' : KINDS.filter((k) => kinds.has(k)).map((k) => KIND_NAMES[k]).join(', ')}
            </>
          }
        >
          {() => (
            <div className="menu-list kind-menu" role="group" aria-label="Kinds">
              {KINDS.map((k) => (
                <button
                  key={k}
                  className={`kind-filter kind-${k}${kinds.has(k) ? ' on' : ''}`}
                  aria-pressed={kinds.has(k)}
                  onClick={() =>
                    setKinds((s) => {
                      const next = new Set(s)
                      if (!next.delete(k)) next.add(k)
                      return next
                    })
                  }
                >
                  <Check className="kind-check" size={14} />
                  <i aria-hidden />
                  {KIND_NAMES[k]}
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
      {ordered.length === 0 && (
        <p className="muted empty">
          No threads yet. The agent&apos;s findings open here after its first pass; select code in the diff to start your own.
        </p>
      )}
      {ordered.length > 0 && shown.length === 0 && <p className="muted empty">No threads match the filters.</p>}
      {shown.map((t) => {
        const header = t.anchor.file !== lastFile ? t.anchor.file : null
        lastFile = t.anchor.file
        const at = locations.get(t.id)
        const s = summaries.get(t.id)
        const replies = s?.replies ?? 0
        const last = s?.lastActivity ?? t.createdAt
        const line = shownLine(t, at)
        const end = at?.kind === 'found' ? at.end : t.anchor.end - t.anchor.start + line
        const queued = props.queue.items.filter((q) => q.threadId === t.id).length
        return (
          <div key={t.id} className="review-thread-group">
            {header && <div className="review-file-label mono">{header}</div>}
            <button className={`review-thread-row${t.resolvedAt !== undefined ? ' resolved' : ''}`} onClick={() => props.onOpenThread(t.id)}>
              <span className={`review-thread-lines kind-${t.resolvedAt !== undefined ? 'resolved' : kindOf(t)}`}>
                <i aria-hidden />
                {line === end ? `L${line}` : `L${line}–${end}`}
              </span>
              <span className="review-thread-body">
                <span className="review-thread-title">{titleOf(t, open.messages)}</span>
                <span className="thread-meta">
                  <span>{KIND_NAMES[kindOf(t)]}</span>
                  <span>
                    {replies} {replies === 1 ? 'reply' : 'replies'}
                  </span>
                  <span title={new Date(last).toLocaleString()}>{ago(last) === 'now' ? 'just now' : `${ago(last)} ago`}</span>
                  {at?.kind === 'outdated' && <span className="tag-outdated">Outdated</span>}
                  {at?.kind === 'gone' && props.diff && <span className="tag-outdated">No longer changed</span>}
                  {t.resolvedAt !== undefined && <span className="tag-resolved">Resolved</span>}
                  {props.runningThread === t.id && (
                    <span className="thread-working">
                      <span className="running-dot" aria-hidden />
                      working
                    </span>
                  )}
                  {queued > 0 && <span className="thread-queued">{queued > 1 ? `${queued} queued` : 'queued'}</span>}
                </span>
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** An agent message in the general conversation: findings blocks become a row. */
function GeneralMessage(props: { message: Message; open: OpenSession; onOpenThread(id: string): void; onShowThreads(): void }): React.JSX.Element {
  const { message, open } = props
  const blocks = findingsBlocks(message.text)
  if (blocks.length === 0) return <Markdown text={message.text} />
  const findings = blocks.flatMap((b) => b.findings)
  const placed = findings.filter((f) => findingThread(f, open.threads))
  const unplaced = findings.filter((f) => !findingThread(f, open.threads))
  return (
    <>
      <Markdown text={withoutFindings(message.text)} />
      <div className="findings-row">
        <button onClick={props.onShowThreads} disabled={placed.length === 0}>
          {findings.length === 0
            ? 'No findings'
            : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}${placed.length > 0 ? `, ${placed.length} opened as threads` : ''}`}
        </button>
        {unplaced.length > 0 && (
          <div className="findings-unplaced">
            <p className="muted">Not on lines the diff shows:</p>
            <ul>
              {unplaced.map((f, i) => (
                <li key={i}>
                  <span className="line-label">{lineLabel(f)}</span> <b>{f.title}</b>
                  {f.body && f.body !== f.title && <Markdown text={f.body} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}

/** The general conversation in the side panel: the session's main thread and its composer. */
export function GeneralPanel(props: {
  width: number | null
  open: OpenSession
  notices: Notice[]
  reveal: Reveal | null
  live: SessionLive
  history: string[]
  runningThread: string | null | undefined
  queue: ComposerQueue
  onSend(text: string, attachments: Attachment[]): void
  onSteer(text: string, attachments: Attachment[]): void
  onCancel(): void
  onBack(): void
  onClose(): void
  onOpenThread(threadId: string): void
}): React.JSX.Element {
  const { open, live, runningThread } = props
  const runningHere = runningThread === null
  return (
    <aside className="thread-panel general-panel" aria-label="General conversation" style={props.width === null ? undefined : { flexBasis: props.width }}>
      <header>
        <button className="back" onClick={props.onBack}>
          <ArrowLeft />
          All threads
        </button>
        <h2 className="thread-label">General conversation</h2>
        {runningHere && <span className="status"><span className="running-dot" aria-hidden="true" />Working</span>}
        <button className="close" onClick={props.onClose} aria-label="Hide panel" title="Hide panel (Ctrl+Shift+T)">
          <PanelRight />
        </button>
      </header>
      <Log
        className="thread-log"
        items={logItems(open, props.notices, null)}
        empty={<p className="muted empty">The first pass starts here.</p>}
        renderAgent={(m) => <GeneralMessage message={m} open={open} onOpenThread={props.onOpenThread} onShowThreads={props.onBack} />}
        systemLine={firstPassLine}
        reveal={props.reveal}
      />
      <Composer
        draftKey={open.session.id}
        className="thread-composer"
        placeholder="Message about the whole change"
        running={runningThread !== undefined}
        autoFocus
        primary
        main
        commands={live.commands}
        accepts={live.accepts}
        history={props.history}
        queue={props.queue}
        onSend={props.onSend}
        onSteer={live.steering && runningHere ? props.onSteer : undefined}
        onCancel={runningHere ? props.onCancel : undefined}
      />
    </aside>
  )
}
