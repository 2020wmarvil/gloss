// A review session's diff (SPEC → Review sessions → Diff view): every file stacked under
// a sticky header, split or unified, with threads as cards under their lines.
import { Fragment, memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { scrollParent, startAutoscroll } from './autoscroll'
import { expandable, gapsOf, languageOf, type DiffFile, type DiffLine, type Location, type Side } from '@shared/review'
import { EXPAND_STEP, gapViews, NO_EXPANSION, type Expansion, type GapView } from './diffContext'
import { cachedColors, colorsInBackground, useHighlighting } from './highlight'
import { Markdown } from './Markdown'
import { KIND_NAMES, type LineThread, type ThreadKind } from './reviewThreads'
import { ago } from './Sidebar'
import { ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, ExternalLink, FileText, Folder } from 'lucide-react'

export type Layout = 'split' | 'unified'

/** A thread as its card shows it. */
export type Card = {
  thread: LineThread
  kind: ThreadKind
  title: string
  /** The finding's text; null for the user's own thread. */
  body: string | null
  replies: number
  lastActivity: number
  running: boolean
  location: Location
  resolved: boolean
}

type Props = {
  files: DiffFile[]
  layout: Layout
  cards: Card[]
  /** The thread open in the side panel, or the new one being written. */
  active: { threadId: string | null; file: string; side: Side; start: number; end: number } | null
  showComments: boolean
  /** Cards collapsed to their marker (or, for resolved threads, expanded). */
  toggled: Set<string>
  /** Files expanded; every file starts collapsed. */
  expandedFiles: Set<string>
  /** Files as they are now, by path, once read for showing the lines around their hunks; null if they can't be. */
  sources: Record<string, string[] | null>
  /** The lines shown around each file's hunks, by path. */
  expansions: Record<string, Expansion>
  onToggleFile(path: string): void
  /** Shows more of a file: lines at one end of a gap (before hunk `gap`, or after the last), a whole gap, or the whole file on or off. */
  onExpand(path: string, how: { gap: number; edge: 'top' | 'bottom' | 'all' } | 'full'): void
  /** Opens a file in the file manager, or in the external editor at `line`. */
  onOpenFile(path: string, how: 'reveal' | 'editor', line: number): void
  onToggleCard(threadId: string): void
  onOpenThread(threadId: string): void
  /**
   * The phone's file screen (SPEC → Remote and mobile): no file header or scroll bar (the screen
   * has its own, and the code scrolls natively), and a tap on a line of code picks it.
   */
  bare?: boolean
  onTapLine?(side: Side, line: number): void
}

/** Whether a thread's card shows: resolved threads start collapsed, the rest expanded. */
export function cardOpen(card: Card, toggled: Set<string>): boolean {
  return toggled.has(card.thread.id) ? card.resolved : !card.resolved
}

export function DiffView(props: Props): React.JSX.Element {
  const { files, cards } = props
  const byFile = useMemo(() => {
    const map = new Map<string, Card[]>()
    for (const c of cards) map.set(c.thread.anchor.file, [...(map.get(c.thread.anchor.file) ?? []), c])
    return map
  }, [cards])
  const gone = [...new Set(cards.filter((c) => c.location.kind === 'gone').map((c) => c.thread.anchor.file))].sort()
  return (
    <div className="diff-view">
      {files.length === 0 && gone.length === 0 && <p className="muted empty diff-empty">Nothing to review: no changes in this selection.</p>}
      {files.map((f, index) => (
        <Fragment key={f.path}>
        {f.outside && !files[index - 1]?.outside && <h3 className="label">Outside this folder</h3>}
        <FileSection
          key={f.path}
          file={f}
          layout={props.layout}
          cards={byFile.get(f.path) ?? []}
          active={props.active?.file === f.path ? props.active : null}
          showComments={props.showComments}
          toggled={props.toggled}
          collapsed={!props.expandedFiles.has(f.path)}
          source={props.sources[f.path]}
          expansion={props.expansions[f.path] ?? NO_EXPANSION}
          onToggleFile={props.onToggleFile}
          onExpand={props.onExpand}
          onOpenFile={props.onOpenFile}
          onToggleCard={props.onToggleCard}
          onOpenThread={props.onOpenThread}
          bare={props.bare}
          onTapLine={props.onTapLine}
        /></Fragment>
      ))}
      {gone.map((path) => (
        <section key={path} className="diff-file gone" data-file={path}>
          <div className="diff-file-head">
            <span className="diff-file-path">{path}</span>
            <span className="diff-chip">no longer changed</span>
          </div>
          <div className="diff-gone-cards">
            {(byFile.get(path) ?? []).map((c) => (
              <ThreadCard key={c.thread.id} card={c} {...cardHandlers(props, c)} active={props.active?.threadId === c.thread.id} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function cardHandlers(props: Pick<Props, 'onToggleCard' | 'onOpenThread'>, c: Card): { onOpen(): void; onCollapse(): void } {
  return { onOpen: () => props.onOpenThread(c.thread.id), onCollapse: () => props.onToggleCard(c.thread.id) }
}

const STATE_NAMES: Record<DiffFile['state'], string> = {
  committed: 'committed',
  uncommitted: 'uncommitted',
  both: 'committed + uncommitted'
}

type FileProps = Omit<Props, 'files' | 'cards' | 'expandedFiles' | 'sources' | 'expansions'> & {
  file: DiffFile
  cards: Card[]
  collapsed: boolean
  /** The file now, once read; null if it can't be. */
  source: string[] | null | undefined
  expansion: Expansion
}

/** Rows of a run of lines: pairs of lines side by side, or one line each. */
type Row = { old: DiffLine | null; new: DiffLine | null }

function rowsOf(lines: DiffLine[], layout: Layout): Row[] {
  if (layout === 'unified') return lines.map((l) => ({ old: l.kind === 'add' ? null : l, new: l.kind === 'del' ? null : l }))
  const rows: Row[] = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === 'context') {
      rows.push({ old: lines[i], new: lines[i] })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ old: dels[k] ?? null, new: adds[k] ?? null })
  }
  return rows
}

type LineColors = Map<DiffLine, { old?: (string | undefined)[]; new?: (string | undefined)[] }>
type Colors = (string | undefined)[] | null

/** Each side of each hunk, highlighted as one piece of code. */
type Piece = { lines: DiffLine[]; side: Side; code: string }

/** Colors of a file's pieces and of the whole file now, as worked out. */
type Colored = { pieces: Piece[]; hunks: Colors[]; source: string[] | null | undefined; sourceColors: Colors }

/**
 * Syntax colors per line and side, highlighting each side of a hunk as one piece of
 * code, and lines shown around the hunks as part of the whole file. Only while the file
 * is shown, and in the background: lines render plain until their colors are ready
 * (SPEC → Performance).
 */
function useColors(file: DiffFile, source: string[] | null | undefined, gaps: GapView[], shown: boolean): LineColors {
  const version = useHighlighting()
  const lang = languageOf(file.path)
  const pieces = useMemo(() => {
    const out: Piece[] = []
    for (const h of file.hunks) {
      for (const side of ['old', 'new'] as const) {
        const lines = h.lines.filter((l) => l[side] !== null)
        out.push({ lines, side, code: lines.map((l) => l.text).join('\n') })
      }
    }
    return out
  }, [file])
  const sourceCode = useMemo(() => source?.join('\n'), [source])
  // Colors already worked out (a file shown again) apply at once.
  const cached = useMemo((): Colored | null => {
    void version
    if (!shown) return null
    const hunks = pieces.map((p) => cachedColors(p.code, lang))
    const sourceColors = sourceCode === undefined ? null : cachedColors(sourceCode, lang)
    if (hunks.some((c) => c === undefined) || sourceColors === undefined) return null
    return { pieces, hunks: hunks as Colors[], source, sourceColors }
  }, [shown, pieces, source, sourceCode, lang, version])
  const [worked, setWorked] = useState<Colored | null>(null)
  useEffect(() => {
    void version
    if (!shown || cached) return
    const hunks: Colors[] = new Array(pieces.length).fill(null)
    let sourceColors: Colors = null
    let left = pieces.length + (sourceCode === undefined ? 0 : 1)
    let live = true
    const finish = (): void => {
      if (--left === 0 && live) startTransition(() => setWorked({ pieces, hunks, source, sourceColors }))
    }
    const cancels = pieces.map((p, i) =>
      colorsInBackground(p.code, lang, (c) => {
        hunks[i] = c
        finish()
      })
    )
    if (sourceCode !== undefined) {
      cancels.push(
        colorsInBackground(sourceCode, lang, (c) => {
          sourceColors = c
          finish()
        })
      )
    }
    return () => {
      live = false
      for (const cancel of cancels) cancel()
    }
  }, [shown, cached, pieces, source, sourceCode, lang, version])
  const colored = cached ?? worked
  return useMemo(() => {
    const out: LineColors = new Map()
    if (!colored) return out
    colored.pieces.forEach((p, i) => {
      const colors = colored.hunks[i]
      if (!colors) return
      let at = 0
      for (const l of p.lines) {
        out.set(l, { ...out.get(l), [p.side]: colors.slice(at, at + l.text.length) })
        at += l.text.length + 1
      }
    })
    if (colored.source && colored.sourceColors) {
      const lines: (string | undefined)[][] = []
      let at = 0
      for (const text of colored.source) {
        lines.push(colored.sourceColors.slice(at, at + text.length))
        at += text.length + 1
      }
      for (const g of gaps) {
        for (const l of [...g.top, ...g.bottom]) {
          const c = lines[l.new! - 1]
          out.set(l, { old: c, new: c })
        }
      }
    }
    return out
  }, [colored, gaps])
}

/** Display width of a line in characters (tabs as 4). */
function width(text: string): number {
  return text.length + (text.match(/\t/g)?.length ?? 0) * 3
}

/** Line rows per block that the browser may skip rendering while off screen. */
const CHUNK = 150

const FileSection = memo(function FileSection(props: FileProps): React.JSX.Element {
  const { file, layout, cards, active, collapsed, source, expansion } = props
  const canExpand = expandable(file) && source !== null
  const gaps = useMemo(() => (canExpand ? gapsOf(file.hunks) : null), [canExpand, file.hunks])
  const views = useMemo(() => (gaps ? gapViews(gaps, source, expansion) : null), [gaps, source, expansion])
  const sectionRef = useRef<HTMLElement>(null)
  /** How tall its lines were when they last left, for the placeholder while they're away. */
  const away = useRef<{ height: number; file: DiffFile; views: GapView[] | null; layout: Layout } | null>(null)
  // The phone shows one file on its own screen: all of it.
  const near = useNear(sectionRef, !props.bare, !collapsed, (el) => {
    const head = el.querySelector<HTMLElement>('.diff-file-head')
    away.current = { height: el.offsetHeight - (head?.offsetHeight ?? 0), file, views, layout }
  })
  /** Its lines are rendered: expanded, and within a screen of the view. */
  const rendered = !collapsed && near
  const colors = useColors(file, source, views ?? NO_GAPS, rendered)
  const [sx, setSx] = useState({ old: 0, new: 0 })
  const bars = useRef<Record<string, HTMLDivElement | null>>({})
  const [selecting, setSelecting] = useState<Side | null>(null)
  const split = layout === 'split'
  const stopAutoscroll = useRef<(() => void) | null>(null)
  useEffect(() => () => stopAutoscroll.current?.(), [])

  const placeOf = (c: Card): number | null =>
    c.location.kind === 'found' ? c.location.end : c.location.kind === 'outdated' ? c.location.at : null
  const markOf = (c: Card): number | null =>
    c.location.kind === 'found' ? c.location.start : c.location.kind === 'outdated' ? c.location.at : null
  const shown = (c: Card): boolean => props.showComments && cardOpen(c, props.toggled)
  const inActive = (side: Side, n: number | null): boolean =>
    active !== null && n !== null && active.side === side && n >= active.start && n <= active.end
  const cardsAt = (side: Side, n: number | null): Card[] =>
    n === null ? [] : cards.filter((c) => c.thread.anchor.side === side && placeOf(c) === n && shown(c))
  const markerAt = (side: Side, n: number | null): Card | undefined =>
    n === null ? undefined : cards.find((c) => c.thread.anchor.side === side && markOf(c) === n)

  const marker = (side: Side, n: number | null): ReactNode => {
    const c = markerAt(side, n)
    if (!c) return null
    return (
      <button
        className={`diff-marker kind-${c.resolved ? 'resolved' : c.kind}${c.location.kind === 'outdated' || c.resolved ? ' hollow' : ''}`}
        data-thread={c.thread.id}
        title={`${c.title} · ${c.replies} ${c.replies === 1 ? 'reply' : 'replies'}`}
        aria-label={`Thread: ${c.title}`}
        onClick={() => {
          if (!shown(c) && props.showComments) props.onToggleCard(c.thread.id)
          props.onOpenThread(c.thread.id)
        }}
      />
    )
  }

  const code = (line: DiffLine, side: Side): ReactNode => {
    const n = side === 'old' ? line.old : line.new
    const cls = line.kind === 'context' ? '' : line.kind
    return (
      <div
        className={`code ${cls}${inActive(side, n) ? ' hl' : ''}`}
        data-side={side}
        data-line={n ?? undefined}
        data-sign={line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
      >
        <span className="w">
          <span className="c">{segments(line.text, colors.get(line)?.[side])}</span>
        </span>
      </div>
    )
  }

  const cardRow = (c: Card, side: Side): ReactNode => (
    <div key={`card:${c.thread.id}`} className={`diff-card-row ${split ? `side-${side}` : ''}`}>
      <ThreadCard card={c} active={active?.threadId === c.thread.id} {...cardHandlers(props, c)} />
    </div>
  )

  const body: ReactNode[] = []
  // Outdated threads with no line left on their side go to the top of the file.
  for (const c of cards) {
    if (c.location.kind === 'outdated' && c.location.at === null && shown(c)) body.push(cardRow(c, c.thread.anchor.side))
  }
  /** The rows of a block, each rendered only once the block is near the view. */
  let chunk: (() => ReactNode)[] = []
  let lines = 0
  const flush = (): void => {
    if (chunk.length === 0) return
    body.push(<DiffChunk key={`chunk:${body.length}`} rows={chunk} lines={lines} lazy={!props.bare} />)
    chunk = []
    lines = 0
  }
  /** A gap's expander: the hunk header after it, with buttons that show the lines it hides. */
  const expander = (g: GapView | undefined, hi: number): ReactNode => {
    const header = file.hunks[hi]?.header
    if (g && g.hidden === 0) return null
    if (!g && header === undefined) return null
    const show = (edge: 'top' | 'bottom' | 'all'): void => props.onExpand(file.path, { gap: hi, edge })
    const first = hi === 0
    const last = hi === file.hunks.length
    const button = (edge: 'top' | 'bottom' | 'all', label: string): ReactNode => (
      <button className={`diff-expand ${edge}`} title={label} aria-label={label} onClick={() => show(edge)}>
        {EXPAND_ICONS[edge]}
      </button>
    )
    return (
      <div key={`h${hi}`} className="diff-hunk">
        {header !== undefined && <span className="diff-hunk-text">{header}</span>}
        {g && (
          // Stacked by where the lines appear: the top of the gap, under the hunk above (or the
          // top of the file), then its bottom, over the hunk below (or the end of the file).
          // Beside them, the whole gap.
          <span className="diff-expanders" role="group" aria-label="Show hidden lines">
            <span className="diff-expand-pair">
              {button('top', first ? `Show ${EXPAND_STEP} more lines from the top of the file` : `Show ${EXPAND_STEP} more lines under the change above`)}
              {button('bottom', last ? `Show ${EXPAND_STEP} more lines from the end of the file` : `Show ${EXPAND_STEP} more lines over the change below`)}
            </span>
            {button('all', g.hidden === null ? 'Show the rest of the file' : `Show all ${g.hidden} hidden lines`)}
          </span>
        )}
      </div>
    )
  }

  const unifiedRow = (key: string, line: DiffLine, oldN: number | null, newN: number | null): ReactNode => {
    const side: Side = line.kind === 'del' ? 'old' : 'new'
    return (
      <div key={key} className="diff-row unified">
        <div className={`mark ${line.kind}`}>{marker(side, side === 'old' ? oldN : newN) ?? (line.kind === 'context' ? marker('old', oldN) : null)}</div>
        <div className={`num ${line.kind}`}>{line.old ?? ''}</div>
        <div className={`num ${line.kind}`}>{line.new ?? ''}</div>
        {code(line, side)}
      </div>
    )
  }

  const pushRows = (prefix: string, lineRun: DiffLine[]): void => {
    rowsOf(lineRun, layout).forEach((r, ri) => {
      const key = `${prefix}:${ri}`
      const oldN = r.old?.old ?? null
      const newN = r.new?.new ?? null
      const row = (): ReactNode =>
        split ? (
          <div key={key} className="diff-row split">
            <div className={`mark ${r.old ? r.old.kind : 'empty'}`}>{marker('old', oldN)}</div>
            <div className={`num ${r.old ? r.old.kind : 'empty'}`}>{oldN ?? ''}</div>
            {r.old ? code(r.old, 'old') : <div className="code empty" />}
            <div className={`mark ${r.new ? r.new.kind : 'empty'}`}>{marker('new', newN)}</div>
            <div className={`num ${r.new ? r.new.kind : 'empty'}`}>{newN ?? ''}</div>
            {r.new ? code(r.new, 'new') : <div className="code empty" />}
          </div>
        ) : (
          unifiedRow(key, (r.old ?? r.new)!, oldN, newN)
        )
      chunk.push(() => [row(), ...cardsAt('old', oldN).map((c) => cardRow(c, 'old')), ...cardsAt('new', newN).map((c) => cardRow(c, 'new'))])
      lines++
      if (lines >= CHUNK) flush()
    })
  }

  // Each hunk, after the lines shown before it; then the lines shown after the last one.
  for (let hi = 0; rendered && hi <= file.hunks.length; hi++) {
    const g = views?.[hi]
    if (g) pushRows(`t${hi}`, g.top)
    const row = expander(g, hi)
    if (row) {
      chunk.push(() => row)
      lines++
    }
    if (g) pushRows(`b${hi}`, g.bottom)
    if (hi < file.hunks.length) pushRows(`${hi}`, file.hunks[hi].lines)
  }
  flush()

  const shownLines = rendered ? [...file.hunks.flatMap((h) => h.lines), ...(views ?? []).flatMap((g) => [...g.top, ...g.bottom])] : []
  const longest = (side: Side): number => Math.max(0, ...shownLines.filter((l) => l[side] !== null).map((l) => width(l.text)))
  const scrollTo = (side: Side | 'both', left: number): void => {
    if (side === 'both') setSx({ old: left, new: left })
    else setSx((s) => ({ ...s, [side]: left }))
  }
  const bar = (side: Side | 'both'): ReactNode => (
    <div
      className="diff-hscroll"
      ref={(el) => {
        bars.current[side] = el
      }}
      onScroll={(e) => scrollTo(side, e.currentTarget.scrollLeft)}
    >
      {/* The code column is about as wide as this bar: scroll by what doesn't fit, plus the sign and padding. */}
      <div style={{ width: `max(100%, ${(side === 'both' ? Math.max(longest('old'), longest('new')) : longest(side)) + 4}ch)` }} />
    </div>
  )
  // The scrollbars take room only while a side has lines too long to fit, so files sit flush.
  const [overflows, setOverflows] = useState(false)
  const widest = [longest('old'), longest('new')].join()
  useLayoutEffect(() => {
    const els = Object.values(bars.current).filter((el): el is HTMLDivElement => el !== null && el.isConnected)
    const measure = (): void => setOverflows(els.some((el) => el.scrollWidth > el.clientWidth + 1))
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed, layout, widest])

  return (
    <section className="diff-file" data-file={file.path} ref={sectionRef}>
      {!props.bare && <div className="diff-file-head" onClick={() => props.onToggleFile(file.path)}>
        <button
          className="diff-chevron"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFile(file.path)
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="diff-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && `${file.oldPath} → `}
          {/* The folder dimmed, so the file's name stands out. */}
          <span className="diff-file-dir">{(file.displayPath ?? file.path).slice(0, (file.displayPath ?? file.path).lastIndexOf('/') + 1)}</span>
          {file.path.slice(file.path.lastIndexOf('/') + 1)}
        </span>
        {file.status === 'added' && <span className="diff-chip">new</span>}
        {file.status === 'deleted' && <span className="diff-chip">deleted</span>}
        <span className={`diff-chip state-${file.state}`}>{file.perforce ? file.perforce.opened ? `Opened (${file.perforce.change === 'default' ? 'default' : `CL ${file.perforce.change}`})` : 'Not opened' : STATE_NAMES[file.state]}</span>
        {file.status !== 'deleted' && (
          <span className="diff-open">
            <button
              className="diff-open-button"
              title={REVEAL_LABEL}
              aria-label={REVEAL_LABEL}
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenFile(file.path, 'reveal', firstLine(file))
              }}
            >
              {FOLDER_ICON}
            </button>
            <button
              className="diff-open-button"
              title="Open in external editor"
              aria-label="Open in external editor"
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenFile(file.path, 'editor', firstLine(file))
              }}
            >
              {EDITOR_ICON}
            </button>
            {canExpand && !collapsed && (
              <button
                className={`diff-open-button${expansion.full ? ' on' : ''}`}
                aria-pressed={expansion.full}
                aria-label="Entire file"
                title={expansion.full ? 'Entire file: on. Click to show only the changes and the lines around them' : 'Show the entire file'}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onExpand(file.path, 'full')
                }}
              >
                {FILE_ICON}
              </button>
            )}
          </span>
        )}
        <span className="diff-counts">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
      </div>}
      {!collapsed &&
        (file.binary ? (
          <p className="muted diff-note">Binary file, not shown.</p>
        ) : file.hunks.length === 0 ? (
          <p className="muted diff-note">No changes to the content.</p>
        ) : !near ? (
          // Until it comes near the view: as tall as its lines will be.
          <div
            className="diff-placeholder"
            style={{
              height:
                away.current && away.current.file === file && away.current.views === views && away.current.layout === layout
                  ? away.current.height
                  : placeholderHeight(file, views, layout)
            }}
          />
        ) : (
          <>
            <div
              className={`diff-body ${layout}`}
              data-sel={selecting ?? undefined}
              style={{ '--sx-old': `${sx.old}px`, '--sx-new': `${sx.new}px` } as CSSProperties}
              onClick={props.onTapLine && ((e) => {
                const cell = (e.target as HTMLElement).closest<HTMLElement>('.code[data-line]')
                if (cell) props.onTapLine!(cell.dataset.side as Side, Number(cell.dataset.line))
              })}
              onMouseDown={(e) => {
                const cell = (e.target as HTMLElement).closest<HTMLElement>('.code[data-side]')
                if (e.button === 1) {
                  // Autoscroll: sideways moves the side pressed on (in split view, both from the gutter), up and down the review.
                  e.preventDefault()
                  const sides = !split ? ['both'] : cell ? [cell.dataset.side as Side] : ['old', 'new']
                  const scroller = scrollParent(e.currentTarget)
                  stopAutoscroll.current = startAutoscroll(e.clientX, e.clientY, (dx, dy) => {
                    for (const s of sides) {
                      const bar = bars.current[s]
                      if (bar) bar.scrollLeft += dx
                    }
                    if (scroller) scroller.scrollTop += dy
                  })
                  return
                }
                setSelecting(split && cell ? (cell.dataset.side as Side) : null)
              }}
              onWheel={(e) => {
                const cell = (e.target as HTMLElement).closest<HTMLElement>('.code[data-side]')
                const dx = e.shiftKey ? e.deltaY : e.deltaX
                if (!cell || !dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return
                const target = bars.current[split ? (cell.dataset.side as Side) : 'both']
                if (target) target.scrollLeft += dx
              }}
            >
              {body}
            </div>
            {!props.bare && <div className={`diff-hbar ${layout}${overflows ? '' : ' idle'}`}>
              {split ? (
                <>
                  <span className="spacer" />
                  {bar('old')}
                  <span className="spacer" />
                  {bar('new')}
                </>
              ) : (
                <>
                  <span className="spacer" />
                  {bar('both')}
                </>
              )}
            </div>}
          </>
        ))}
    </section>
  )
})

const NO_GAPS: GapView[] = []

/** A block of rows: rendered while within a screen of the view, else as tall as they were or will be (SPEC → Performance). */
function DiffChunk(props: { rows: (() => ReactNode)[]; lines: number; lazy: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const height = useRef<number | null>(null)
  const near = useNear(ref, props.lazy, true, (el) => {
    height.current = el.offsetHeight
  })
  return (
    <div
      ref={ref}
      className="diff-chunk"
      style={near ? { containIntrinsicSize: `auto ${props.lines * ROW_PX}px` } : { height: height.current ?? props.lines * ROW_PX }}
    >
      {near && props.rows.map((row) => row())}
    </div>
  )
}

/** Line rows and hunk headers are this tall (styles.css). */
const ROW_PX = 20
const HUNK_PX = 32

function placeholderHeight(file: DiffFile, views: GapView[] | null, layout: Layout): number {
  let rows = 0
  for (const h of file.hunks) rows += rowsOf(h.lines, layout).length
  for (const g of views ?? []) rows += g.top.length + g.bottom.length
  return rows * ROW_PX + (file.hunks.length + 1) * HUNK_PX
}

/**
 * Whether an element is within a screen of its scroller's view while `watching` (SPEC →
 * Performance); `onLeave` runs as it moves away, before its content goes. Always when
 * not `lazy`, or without IntersectionObserver (tests).
 */
function useNear(ref: React.RefObject<HTMLElement | null>, lazy: boolean, watching: boolean, onLeave: (el: HTMLElement) => void): boolean {
  const enabled = lazy && typeof IntersectionObserver !== 'undefined'
  const [near, setNear] = useState(!enabled)
  const nearNow = useRef(near)
  const leave = useRef(onLeave)
  leave.current = onLeave
  // Already near when it mounts: rendered before the first paint, not a frame later.
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !watching || !el || nearNow.current) return
    const view = el.closest<HTMLElement>('.review-scroll')?.getBoundingClientRect()
    if (!view) return
    const box = el.getBoundingClientRect()
    const margin = view.height
    if (box.bottom > view.top - margin && box.top < view.bottom + margin) {
      nearNow.current = true
      setNear(true)
    }
  }, [ref, enabled, watching])
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    if (!watching) {
      nearNow.current = false
      setNear(false)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const now = entries[entries.length - 1].isIntersecting
        if (nearNow.current && !now) leave.current(el)
        nearNow.current = now
        setNear(now)
      },
      { root: el.closest<HTMLElement>('.review-scroll'), rootMargin: '100% 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, enabled, watching])
  return near
}

/** Where the editor opens a file: its first added line, else the first line its hunks show. */
export function firstLine(file: DiffFile): number {
  const lines = file.hunks.flatMap((h) => h.lines)
  return lines.find((l) => l.kind === 'add')?.new ?? lines.find((l) => l.new !== null)?.new ?? 1
}

/** The file manager's name on this system. */
export const REVEAL_LABEL = /Mac/.test(navigator.userAgent)
  ? 'Reveal in Finder'
  : /Windows/.test(navigator.userAgent)
    ? 'Show in File Explorer'
    : 'Show in folder'

const FOLDER_ICON = <Folder size={14} />
const FILE_ICON = <FileText size={14} />
const EDITOR_ICON = <ExternalLink size={14} />

/** The expanders' buttons: up for the top of a gap, down for its bottom, up and down for all of it. */
const EXPAND_ICONS = {
  top: <ChevronUp size={13} />,
  all: <ChevronsUpDown size={14} />,
  bottom: <ChevronDown size={13} />
}

/** Keeps an empty line one line tall (a zero-width space). */
export const EMPTY_LINE = String.fromCharCode(0x200b)

/** Text in runs of one color. */
function segments(text: string, colors: (string | undefined)[] | undefined): ReactNode {
  if (!text) return EMPTY_LINE
  if (!colors) return text
  const out: ReactNode[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || colors[i] !== colors[start]) {
      const part = text.slice(start, i)
      out.push(colors[start] ? <span key={start} style={{ color: colors[start] }}>{part}</span> : part)
      start = i
    }
  }
  return out
}

/** A thread under its lines: severity, title, the start of the finding, and its state. */
export function ThreadCard(props: { card: Card; active: boolean; onOpen(): void; onCollapse(): void }): React.JSX.Element {
  const { card } = props
  const kind = card.resolved ? 'resolved' : card.kind
  return (
    <div
      className={`thread-card kind-${kind}${props.active ? ' active' : ''}${card.resolved ? ' resolved' : ''}`}
      data-thread={card.thread.id}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onOpen()
      }}
    >
      <div className="thread-card-top">
        <span className={`kind-chip kind-${card.kind}`}>{KIND_NAMES[card.kind]}</span>
        {card.location.kind === 'outdated' && (
          <span className="tag-outdated" title="The lines this thread was on have changed">
            Outdated
          </span>
        )}
        {card.resolved && <span className="tag-resolved">Resolved</span>}
        <span className="thread-card-title">{card.title}</span>
        <button
          className="thread-card-collapse"
          title="Collapse to the gutter marker"
          aria-label="Collapse"
          onClick={(e) => {
            e.stopPropagation()
            props.onCollapse()
          }}
        >
          <ChevronUp size={14} />
        </button>
      </div>
      {card.body && (
        <div className="thread-card-body">
          <Markdown text={card.body} />
        </div>
      )}
      {card.location.kind === 'outdated' && <pre className="thread-card-orig">{card.thread.anchor.lines.join('\n')}</pre>}
      <div className="thread-card-meta">
        <span>
          {card.replies} {card.replies === 1 ? 'reply' : 'replies'}
        </span>
        <span title={new Date(card.lastActivity).toLocaleString()}>
          {ago(card.lastActivity) === 'now' ? 'just now' : `${ago(card.lastActivity)} ago`}
        </span>
        {card.running && (
          <span className="thread-working">
            <span className="running-dot" aria-hidden />
            working
          </span>
        )}
      </div>
    </div>
  )
}
