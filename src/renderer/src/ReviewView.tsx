// A review session's main view (docs/mocks/review-session.html): the branch's diff with
// threads on its lines. The general conversation lives in the side panel.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import { linesOf, type LineAnchor, type Location, type ReviewDiff, type Side } from '@shared/review'
import type { MessageQueue, SessionLive } from '@shared/types'
import type { OpenSession, Panel } from './App'
import { DiffView, EMPTY_LINE, cardOpen, type Card, type Layout } from './DiffView'
import { inDiffOrder, isLineThread, kindOf, titleOf } from './reviewThreads'
import { StatusLine } from './StatusLine'
import { threadSummaries } from './ThreadsOverview'
import { modKey } from './shortcuts'

export type DiffState = { diff: ReviewDiff | null; error: string | null }

type Props = {
  open: OpenSession
  agentName: string
  diff: DiffState
  locations: Map<string, Location>
  /** The side panel's thread while it is expanded. */
  panel: Panel | null
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  live: SessionLive
  git: GitStatus | null
  pr: PullRequest | null
  queue: MessageQueue
  onResumeQueue(): void
  onSetChoice(kind: 'model' | 'effort', value: string): Promise<void>
  /** Sends a slash command from the status line to the main conversation. */
  onCommand(text: string): void
  onOpenThread(threadId: string): void
  /** Opens a new thread (or the existing one) on selected lines. */
  onReplyLines(anchor: LineAnchor): void
}

/** A UI preference kept in localStorage (SPEC → Review sessions → Diff view). */
function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key) as T | null
    return stored !== null && allowed.includes(stored) ? stored : fallback
  })
  const set = useCallback(
    (v: T) => {
      localStorage.setItem(key, v)
      setValue(v)
    },
    [key]
  )
  return [value, set]
}

/** Below this width of the diff, split shows as unified. */
const SPLIT_MIN_WIDTH = 640

export function ReviewView(props: Props): React.JSX.Element {
  const { open, diff, locations, panel } = props
  const files = diff.diff?.files ?? []
  const [layout, setLayout] = useStored<Layout>('gloss.review.layout', 'split', ['split', 'unified'])
  const [tree, setTree] = useStored('gloss.review.tree', 'shown', ['shown', 'hidden'])
  const [comments, setComments] = useStored('gloss.review.comments', 'shown', ['shown', 'hidden'])
  const [toggled, setToggled] = useState(() => new Set<string>())
  const [toggledFiles, setToggledFiles] = useState(() => new Set<string>())
  const [narrow, setNarrow] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const shownLayout: Layout = layout === 'split' && !narrow ? 'split' : 'unified'

  // Split needs room for two columns of code.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setNarrow(el.clientWidth < SPLIT_MIN_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [diff.diff !== null])

  const summaries = new Map(threadSummaries(open).map((s) => [s.thread.id, s]))
  const ordered = inDiffOrder(open.threads, diff.diff, locations)
  const cards: Card[] = ordered.map((t) => {
    const s = summaries.get(t.id)
    return {
      thread: t,
      kind: kindOf(t),
      title: titleOf(t, open.messages),
      body: t.finding?.body ?? null,
      replies: s?.replies ?? 0,
      lastActivity: s?.lastActivity ?? t.createdAt,
      running: props.runningThread === t.id,
      location: locations.get(t.id) ?? { kind: 'gone' },
      resolved: t.resolvedAt !== undefined
    }
  })
  const openThreads = ordered.filter((t) => t.resolvedAt === undefined)
  const activeThread = panel?.threadId ? open.threads.find((t) => t.id === panel.threadId) : undefined
  const activeAt = activeThread ? locations.get(activeThread.id) : undefined
  const active =
    panel && panel.anchor.kind === 'line'
      ? {
          threadId: panel.threadId,
          file: panel.anchor.file,
          side: panel.anchor.side,
          ...(activeAt?.kind === 'found'
            ? { start: activeAt.start, end: activeAt.end }
            : activeAt
              ? { start: -1, end: -1 }
              : { start: panel.anchor.start, end: panel.anchor.end })
        }
      : null
  const position = openThreads.findIndex((t) => t.id === panel?.threadId)

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set)
    if (!next.delete(id)) next.add(id)
    return next
  }

  /** Goes to the next (1) or previous (-1) open thread, expanding its card. */
  const step = (by: 1 | -1): void => {
    if (openThreads.length === 0) return
    const i = position < 0 ? (by > 0 ? 0 : openThreads.length - 1) : (position + by + openThreads.length) % openThreads.length
    const t = openThreads[i]
    const card = cards.find((c) => c.thread.id === t.id)
    if (card && comments === 'shown' && !cardOpen(card, toggled)) setToggled((s) => toggle(s, t.id))
    props.onOpenThread(t.id)
  }
  const stepRef = useRef(step)
  stepRef.current = step
  const commentsRef = useRef(comments)
  commentsRef.current = comments

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setComments(commentsRef.current === 'shown' ? 'hidden' : 'shown')
        return
      }
      const target = e.target as HTMLElement | null
      if (mod || e.altKey || target?.isContentEditable || target?.matches?.('input, textarea')) return
      if (e.key === 'n' || e.key === 'N') stepRef.current(1)
      else if (e.key === 'p' || e.key === 'P') stepRef.current(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setComments])

  // Bring the open thread into view: its card, or its marker.
  const panelThread = panel?.threadId ?? null
  useEffect(() => {
    const el = scroller.current
    if (!el || !panelThread) return
    const target =
      el.querySelector<HTMLElement>(`.thread-card[data-thread="${CSS.escape(panelThread)}"]`) ??
      el.querySelector<HTMLElement>(`[data-thread="${CSS.escape(panelThread)}"]`)
    if (!target) return
    const box = target.getBoundingClientRect()
    const view = el.getBoundingClientRect()
    if (box.top < view.top + 40 || box.bottom > view.bottom) target.scrollIntoView?.({ block: 'center' })
  }, [panelThread, comments])

  /** The file whose section is at the top of the diff, for the tree. */
  const track = (): void => {
    const el = scroller.current
    if (!el) return
    let at: string | null = null
    for (const section of el.querySelectorAll<HTMLElement>('.diff-file')) {
      if (section.offsetTop - el.offsetTop <= el.scrollTop + 8) at = section.dataset.file ?? null
    }
    setCurrent(at ?? files[0]?.path ?? null)
  }

  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  const lineThreads = open.threads.filter(isLineThread)

  return (
    <main className="conversation review" ref={mainRef}>
      <header className="review-head">
        <div className="review-titles">
          <h1 title={open.session.title}>{open.session.title}</h1>
          <span className="mono">
            {props.agentName}
            {diff.diff && (
              <>
                {' '}
                · vs {diff.diff.baseRef} @ {diff.diff.base.slice(0, 7)} · {files.length} {files.length === 1 ? 'file' : 'files'}{' '}
                <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
              </>
            )}
          </span>
        </div>
        <div className="review-tools">
          <button className={`tool-button${tree === 'shown' ? ' on' : ''}`} aria-pressed={tree === 'shown'} onClick={() => setTree(tree === 'shown' ? 'hidden' : 'shown')}>
            Files
          </button>
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              className={shownLayout === 'split' ? 'on' : undefined}
              aria-pressed={layout === 'split'}
              title={layout === 'split' && narrow ? 'Not enough room for side by side' : 'Side by side'}
              onClick={() => setLayout('split')}
            >
              Split
            </button>
            <button className={shownLayout === 'unified' ? 'on' : undefined} aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>
              Unified
            </button>
          </div>
          <button
            className={`tool-button${comments === 'shown' ? ' on' : ''}`}
            aria-pressed={comments === 'shown'}
            title={`Show or hide comments (${modKey()}+Shift+H)`}
            onClick={() => setComments(comments === 'shown' ? 'hidden' : 'shown')}
          >
            {comments === 'shown' ? 'Comments shown' : 'Comments hidden'}
          </button>
          <button className="tool-button" title="Previous open thread (P)" aria-label="Previous open thread" onClick={() => step(-1)}>
            ↑
          </button>
          <span className="review-position">
            {position >= 0 ? `${position + 1} of ${openThreads.length} open` : `${openThreads.length} open`}
          </span>
          <button className="tool-button" title="Next open thread (N)" aria-label="Next open thread" onClick={() => step(1)}>
            ↓
          </button>
        </div>
      </header>
      <div className="review-body">
        {tree === 'shown' && files.length > 0 && (
          <nav className="file-tree" aria-label="Files">
            <div className="label">
              <span>Files</span>
              <span>{files.length}</span>
            </div>
            {files.map((f) => {
              const unresolved = lineThreads.filter((t) => t.anchor.file === f.path && t.resolvedAt === undefined).length
              const slash = f.path.lastIndexOf('/')
              return (
                <button
                  key={f.path}
                  className={`file-tree-item${(current ?? files[0]?.path) === f.path ? ' current' : ''}`}
                  title={f.path}
                  onClick={() => {
                    setToggledFiles((s) => {
                      const next = new Set(s)
                      next.delete(f.path)
                      return next
                    })
                    setCurrent(f.path)
                    requestAnimationFrame(() =>
                      scroller.current?.querySelector(`.diff-file[data-file="${CSS.escape(f.path)}"]`)?.scrollIntoView?.({ block: 'start' })
                    )
                  }}
                >
                  <span className="file-tree-line">
                    <span className="file-tree-name">{f.path.slice(slash + 1)}</span>
                    {unresolved > 0 && <span className="count-pill">{unresolved}</span>}
                    <span className="file-tree-counts">
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </span>
                  </span>
                  {slash > 0 && <span className="file-tree-dir">{f.path.slice(0, slash)}</span>}
                </button>
              )
            })}
          </nav>
        )}
        <div className="review-scroll" ref={scroller} onScroll={track}>
          {diff.error && <p className="notice review-error">Couldn&apos;t read the diff: {diff.error}</p>}
          {!diff.diff && !diff.error && <p className="muted empty diff-empty">Reading the diff…</p>}
          {diff.diff && (
            <DiffView
              files={files}
              layout={shownLayout}
              cards={cards}
              active={active}
              showComments={comments === 'shown'}
              toggled={toggled}
              toggledFiles={toggledFiles}
              onToggleFile={(path) => setToggledFiles((s) => toggle(s, path))}
              onToggleCard={(id) => setToggled((s) => toggle(s, id))}
              onOpenThread={props.onOpenThread}
            />
          )}
        </div>
      </div>
      <StatusLine
        session={open.session}
        live={props.live}
        git={props.git}
        pr={props.pr}
        running={props.runningThread !== undefined}
        queue={props.queue}
        onResumeQueue={props.onResumeQueue}
        onSetChoice={props.onSetChoice}
        onCommand={props.onCommand}
      />
      {diff.diff && <DiffSelectionPopover scope={scroller} diff={diff.diff} layout={shownLayout} onReply={props.onReplyLines} />}
    </main>
  )
}

type Selected = { anchor: LineAnchor; top: number; left: number; bottom: number }

/** "Reply to selection" for code selected in the diff (SPEC → Review sessions → Line anchors). */
function DiffSelectionPopover(props: {
  scope: React.RefObject<HTMLDivElement | null>
  diff: ReviewDiff
  layout: Layout
  onReply(anchor: LineAnchor): void
}): React.JSX.Element | null {
  const { scope, diff, layout, onReply } = props
  const [current, setCurrent] = useState<Selected | null>(null)
  const frame = useRef(0)

  const compute = useCallback(() => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return setCurrent(null)
    const range = s.getRangeAt(0)
    const element = (n: Node): Element | null => (n instanceof Element ? n : n.parentElement)
    const section = element(range.startContainer)?.closest<HTMLElement>('.diff-file[data-file]')
    if (!section || !scope.current?.contains(section) || element(range.endContainer)?.closest('.diff-file') !== section) {
      return setCurrent(null)
    }
    const file = diff.files.find((f) => f.path === section.dataset.file)
    const body = section.querySelector<HTMLElement>('.diff-body')
    if (!file || !body) return setCurrent(null)
    const cells = [...body.querySelectorAll<HTMLElement>('.code[data-line]')].filter((c) => range.intersectsNode(c))
    // In split view the selection stays on the side it started on; in unified view a
    // selection over removed and added lines is on the new side.
    const side: Side =
      layout === 'split'
        ? ((body.dataset.sel as Side | undefined) ?? (cells[0]?.dataset.side as Side | undefined) ?? 'new')
        : cells.some((c) => c.dataset.side === 'new')
          ? 'new'
          : 'old'
    const numbers = cells.filter((c) => c.dataset.side === side).map((c) => Number(c.dataset.line))
    const text = s.toString().split(EMPTY_LINE).join('').trim()
    if (numbers.length === 0 || !text) return setCurrent(null)
    const start = Math.min(...numbers)
    const end = Math.max(...numbers)
    const lines = linesOf(file, side, start, end)
    if (!lines) return setCurrent(null)
    const rect = range.getBoundingClientRect()
    setCurrent({
      anchor: { kind: 'line', file: file.path, side, start, end, text, lines },
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom
    })
  }, [scope, diff, layout])

  useEffect(() => {
    const schedule = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(compute)
    }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame.current)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [compute])

  const reply = useCallback(() => {
    if (!current) return
    window.getSelection()?.removeAllRanges()
    setCurrent(null)
    onReply(current.anchor)
  }, [current, onReply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (!current || e.ctrlKey || e.metaKey || e.altKey || target?.isContentEditable || target?.matches?.('input, textarea')) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        reply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, reply])

  if (!current) return null
  const top = current.top - 50 >= 8 ? current.top - 50 : current.bottom + 8
  const left = Math.max(8, Math.min(current.left, window.innerWidth - 278))
  return (
    <div className="selection-popover" role="toolbar" aria-label="Selection" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      <button className="go" onClick={reply}>
        ↩ Reply to selection <kbd>R</kbd>
      </button>
      <button className="copy" onClick={() => document.execCommand('copy')}>
        Copy
      </button>
    </div>
  )
}
