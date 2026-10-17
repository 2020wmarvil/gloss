// A review session's main view (docs/mocks/review-session.html): the branch's diff with
// threads on its lines. The general conversation lives in the side panel.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import { LARGE_FILE_LINES, linesOf, type LineAnchor, type Location, type ReviewDiff, type ReviewRange, type ReviewRefs, type Side } from '@shared/review'
import type { MessageQueue, SessionLive } from '@shared/types'
import type { OpenSession, Panel } from './App'
import { DiffView, EMPTY_LINE, cardOpen, firstLine, REVEAL_LABEL, type Card, type Layout } from './DiffView'
import { expand, NO_EXPANSION, type Expansion } from './diffContext'
import { RangePicker } from './RangePicker'
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
  obsidianVault?: string
  queue: MessageQueue
  onResumeQueue(): void
  onSetChoice(kind: 'model' | 'effort', value: string): Promise<void>
  /** Sends a slash command from the status line to the main conversation. */
  onCommand(text: string): void
  onOpenThread(threadId: string): void
  /** Opens a new thread (or the existing one) on selected lines. */
  onReplyLines(anchor: LineAnchor): void
  /** Changes what the diff compares. */
  onSetRange(range: ReviewRange): void
  /** A session is being started. */
  creating: boolean
  /** Starts a fresh review session of the same range; this one stays. */
  onNewReview(): void
  /** Opens a file of the diff in the file manager, or in the external editor at `line`. */
  onOpenFile(path: string, how: 'reveal' | 'editor', line: number): void
}

const icon = (paths: string[], size = 16): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
)

/** The header's tool icons. */
const ICONS = {
  /** A circular arrow: start again. */
  newReview: icon(['M3 12a9 9 0 1 0 2.6-6.4L3 8', 'M3 3v5h5']),
  /** A panel on the left. */
  files: icon(['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 4v16']),
  /** Chevrons pointing in, and out. */
  collapseAll: icon(['M7 20l5-5 5 5', 'M7 4l5 5 5-5']),
  expandAll: icon(['M7 15l5 5 5-5', 'M7 9l5-5 5 5']),
  /** Two columns, and one. */
  split: icon(['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M12 4v16']),
  unified: icon(['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M7 9h10', 'M7 13h10', 'M7 17h6']),
  /** A speech bubble, and one struck through. */
  comments: icon(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']),
  commentsHidden: icon(['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M3 3l18 18']),
  up: icon(['M6 15l6-6 6 6'], 12),
  down: icon(['M6 9l6 6 6-6'], 12)
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

const TREE_KEY = 'gloss.review.tree'

/** Hides the file list for the next review shown; it is remembered from then on. */
export function hideFileList(): void {
  localStorage.setItem(TREE_KEY, 'hidden')
}

/** Below this width of the diff, split shows as unified. */
const SPLIT_MIN_WIDTH = 640

export function ReviewView(props: Props): React.JSX.Element {
  const { open, diff, locations, panel } = props
  const files = diff.diff?.files ?? []
  const [layout, setLayout] = useStored<Layout>('gloss.review.layout', 'split', ['split', 'unified'])
  const [tree, setTree] = useStored(TREE_KEY, 'shown', ['shown', 'hidden'])
  const [comments, setComments] = useStored('gloss.review.comments', 'shown', ['shown', 'hidden'])
  const [toggled, setToggled] = useState(() => new Set<string>())
  const [toggledFiles, setToggledFiles] = useState(() => new Set<string>())
  const [expansions, setExpansions] = useState<Record<string, Expansion>>({})
  const [sources, setSources] = useState<Record<string, string[] | null>>({})
  /** Paths whose file is read, or being read, for the lines around their hunks. */
  const reading = useRef(new Set<string>())
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

  const sessionId = open.session.id
  const readSource = useCallback(
    (path: string) => {
      reading.current.add(path)
      window.gloss.sessions
        .reviewFile(sessionId, path)
        .catch(() => null)
        .then((lines) => setSources((s) => ({ ...s, [path]: lines })))
    },
    [sessionId]
  )
  // Files shown beyond their hunks follow the diff as it is re-read.
  useEffect(() => {
    for (const path of reading.current) readSource(path)
  }, [diff.diff, readSource])
  // Another range is another diff: nothing shown beyond its hunks yet.
  const review = open.session.review
  const rangeKey = review ? `${review.baseRef}\0${review.headRef ?? ''}` : ''
  useEffect(() => {
    reading.current.clear()
    setSources({})
    setExpansions({})
  }, [rangeKey])

  /** The file tree's context menu: the file, and where it opened. */
  const [fileMenu, setFileMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  // Clicks elsewhere, scrolling and Escape close it.
  useEffect(() => {
    if (!fileMenu) return
    const close = (): void => setFileMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [fileMenu])

  /** What the range dropdowns offer; null until listed. */
  const [refs, setRefs] = useState<ReviewRefs | null>(null)
  const loadRefs = useCallback(() => {
    window.gloss.sessions.reviewRefs(sessionId).then(setRefs, () => undefined)
  }, [sessionId])
  useEffect(loadRefs, [loadRefs])
  const onExpand = useCallback(
    (path: string, how: Parameters<typeof expand>[1]) => {
      setExpansions((e) => ({ ...e, [path]: expand(e[path] ?? NO_EXPANSION, how) }))
      if (!reading.current.has(path)) readSource(path)
    },
    [readSource]
  )

  /** Whether a file is collapsed: large ones start collapsed, and a click flips it. */
  const isCollapsed = (path: string, lines: number): boolean => toggledFiles.has(path) !== lines > LARGE_FILE_LINES
  const allCollapsed = files.length > 0 && files.every((f) => isCollapsed(f.path, f.additions + f.deletions))
  /** Collapses every file, or expands every file when all are collapsed. */
  const toggleAll = (): void =>
    setToggledFiles(new Set(files.filter((f) => (f.additions + f.deletions > LARGE_FILE_LINES) === allCollapsed).map((f) => f.path)))

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
          <span className="mono review-meta">
            {props.agentName}
            {review && <RangePicker range={review} diff={diff.diff} refs={refs} onRefresh={loadRefs} onChange={props.onSetRange} />}
            {diff.diff && (
              <span>
                {files.length} {files.length === 1 ? 'file' : 'files'} <span className="add">+{additions}</span>{' '}
                <span className="del">−{deletions}</span>
              </span>
            )}
          </span>
        </div>
        <div className="review-tools">
          <button
            className={`tool-button icon${tree === 'shown' ? ' on' : ''}`}
            aria-pressed={tree === 'shown'}
            title={tree === 'shown' ? 'Hide the file list' : 'Show the file list'}
            aria-label="File list"
            onClick={() => setTree(tree === 'shown' ? 'hidden' : 'shown')}
          >
            {ICONS.files}
          </button>
          <button
            className="tool-button icon"
            disabled={files.length === 0}
            title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
            aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
            onClick={toggleAll}
          >
            {allCollapsed ? ICONS.expandAll : ICONS.collapseAll}
          </button>
          <div className="segmented icons" role="group" aria-label="Diff layout">
            <button
              className={shownLayout === 'split' ? 'on' : undefined}
              aria-pressed={layout === 'split'}
              aria-label="Split"
              title={layout === 'split' && narrow ? 'Split: not enough room for side by side' : 'Split: side by side'}
              onClick={() => setLayout('split')}
            >
              {ICONS.split}
            </button>
            <button
              className={shownLayout === 'unified' ? 'on' : undefined}
              aria-pressed={layout === 'unified'}
              aria-label="Unified"
              title="Unified: one column"
              onClick={() => setLayout('unified')}
            >
              {ICONS.unified}
            </button>
          </div>
          <button
            className={`tool-button icon${comments === 'shown' ? ' on' : ''}`}
            aria-pressed={comments === 'shown'}
            aria-label="Comments"
            title={`${comments === 'shown' ? 'Hide' : 'Show'} comments (${modKey()}+Shift+H)`}
            onClick={() => setComments(comments === 'shown' ? 'hidden' : 'shown')}
          >
            {comments === 'shown' ? ICONS.comments : ICONS.commentsHidden}
          </button>
          <span className="review-position">
            {position >= 0 ? `${position + 1} of ${openThreads.length} open` : `${openThreads.length} open`}
          </span>
          <span className="review-step" role="group" aria-label="Open threads">
            <button title="Previous open thread (P)" aria-label="Previous open thread" onClick={() => step(-1)}>
              {ICONS.up}
            </button>
            <button title="Next open thread (N)" aria-label="Next open thread" onClick={() => step(1)}>
              {ICONS.down}
            </button>
          </span>
          {/* Starts another session rather than changing this view, so it stands apart. */}
          <span className="tool-divider" aria-hidden />
          <button
            className="tool-button icon"
            disabled={props.creating}
            title="New review: a fresh review of this range, with a new agent session and a new first pass. This one stays in the sidebar."
            aria-label="New review"
            onClick={props.onNewReview}
          >
            {ICONS.newReview}
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
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (f.status !== 'deleted') setFileMenu({ path: f.path, x: e.clientX, y: e.clientY })
                  }}
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
        {fileMenu && (
          <div
            className="menu file-menu"
            role="menu"
            style={{ left: fileMenu.x, top: fileMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(['reveal', 'editor'] as const).map((how) => (
              <button
                key={how}
                role="menuitem"
                onClick={() => {
                  const file = files.find((f) => f.path === fileMenu.path)
                  setFileMenu(null)
                  if (file) props.onOpenFile(file.path, how, firstLine(file))
                }}
              >
                {how === 'reveal' ? REVEAL_LABEL : 'Open in external editor'}
              </button>
            ))}
          </div>
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
              sources={sources}
              expansions={expansions}
              onToggleFile={(path) => setToggledFiles((s) => toggle(s, path))}
              onExpand={onExpand}
              onOpenFile={props.onOpenFile}
              onToggleCard={(id) => setToggled((s) => toggle(s, id))}
              onOpenThread={props.onOpenThread}
            />
          )}
        </div>
      </div>
      <StatusLine
        obsidianVault={props.obsidianVault}
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
