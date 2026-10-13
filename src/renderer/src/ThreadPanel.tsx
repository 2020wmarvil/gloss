// The side panel for one thread: anchor quote, the thread's messages, composer.
import { useEffect } from 'react'
import type { Attachment, SessionLive } from '@shared/types'
import { wireTag } from '@shared/wire'
import type { OpenSession, Panel } from './App'
import { itemSource, listItemSpans } from './anchors'
import { Composer } from './Composer'
import { ExportMenu } from './ExportMenu'
import { Log, logItems, type Notice } from './Log'
import { Markdown } from './Markdown'

type Props = {
  open: OpenSession
  panel: Panel
  label: string
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  notices: Notice[]
  live: SessionLive
  onSend(text: string, attachments: Attachment[]): void
  onCancel(): void
  onClose(): void
  onCopyMarkdown(threadId: string): void
  onSaveMarkdown(threadId: string): void
}

export function ThreadPanel(props: Props): React.JSX.Element {
  const { open, panel, label, runningThread, notices, live, onSend, onCancel, onClose } = props
  const threadId = panel.threadId
  const running = runningThread !== undefined
  const runningHere = running && panel.threadId !== null && runningThread === panel.threadId

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <aside className="thread-panel" aria-label="Thread">
      <header>
        <h2>{isSelection && panel.threadId === null ? 'New thread' : 'Thread'}</h2>
        <span className="mono">{label}</span>
        {runningHere && <span className="status">Agent is working…</span>}
        {threadId !== null && (
          <ExportMenu
            label="thread"
            onCopy={() => props.onCopyMarkdown(threadId)}
            onSave={() => props.onSaveMarkdown(threadId)}
          />
        )}
        <button className="close" onClick={onClose} aria-label="Close thread" title="Close (Esc)">
          ×
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
      />
      <Composer
        key={`${panel.anchorMessageId}:${JSON.stringify(panel.anchor)}`}
        className="thread-composer"
        placeholder="Reply in thread"
        running={running}
        autoFocus
        primary
        commands={live.commands}
        accepts={live.accepts}
        onSend={onSend}
        onCancel={onCancel}
        footer={<div className="mono wire">sent as: {wireTag(panel.anchor.text)} …</div>}
      />
    </aside>
  )
}
