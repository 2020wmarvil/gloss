// A review session's diff (SPEC → Review sessions → Diff view): every file stacked under
// a sticky header, split or unified, with threads as cards under their lines.
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { expandable, gapsOf, languageOf, LARGE_FILE_LINES, type DiffFile, type DiffLine, type Location, type Side } from '@shared/review'
import { EXPAND_STEP, gapViews, NO_EXPANSION, type Expansion, type GapView } from './diffContext'
import { codeColors, useHighlighting } from './highlight'
import { Markdown } from './Markdown'
import { KIND_NAMES, type LineThread, type ThreadKind } from './reviewThreads'
import { ago } from './Sidebar'

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
  /** Files collapsed or expanded by hand (large ones start collapsed). */
  toggledFiles: Set<string>
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
      {files.length === 0 && gone.length === 0 && <p className="muted empty diff-empty">Nothing to review: the branch has no changes.</p>}
      {files.map((f) => (
        <FileSection
          key={f.path}
          file={f}
          layout={props.layout}
          cards={byFile.get(f.path) ?? []}
          active={props.active?.file === f.path ? props.active : null}
          showComments={props.showComments}
          toggled={props.toggled}
          collapsed={props.toggledFiles.has(f.path) !== f.additions + f.deletions > LARGE_FILE_LINES}
          source={props.sources[f.path]}
          expansion={props.expansions[f.path] ?? NO_EXPANSION}
          onToggleFile={props.onToggleFile}
          onExpand={props.onExpand}
          onOpenFile={props.onOpenFile}
          onToggleCard={props.onToggleCard}
          onOpenThread={props.onOpenThread}
        />
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

type FileProps = Omit<Props, 'files' | 'cards' | 'toggledFiles' | 'sources' | 'expansions'> & {
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

/**
 * Syntax colors per line and side, highlighting each side of a hunk as one piece of
 * code, and lines shown around the hunks as part of the whole file.
 */
function useColors(file: DiffFile, source: string[] | null | undefined, gaps: GapView[]): LineColors {
  const version = useHighlighting()
  const hunkColors = useMemo(() => {
    void version
    const out: LineColors = new Map()
    const lang = languageOf(file.path)
    for (const h of file.hunks) {
      for (const side of ['old', 'new'] as const) {
        const lines = h.lines.filter((l) => l[side] !== null)
        const colors = codeColors(lines.map((l) => l.text).join('\n'), lang)
        if (!colors) continue
        let at = 0
        for (const l of lines) {
          out.set(l, { ...out.get(l), [side]: colors.slice(at, at + l.text.length) })
          at += l.text.length + 1
        }
      }
    }
    return out
  }, [file, version])
  const sourceColors = useMemo(() => {
    void version
    if (!source) return null
    const colors = codeColors(source.join('\n'), languageOf(file.path))
    if (!colors) return null
    const lines: (string | undefined)[][] = []
    let at = 0
    for (const text of source) {
      lines.push(colors.slice(at, at + text.length))
      at += text.length + 1
    }
    return lines
  }, [file.path, source, version])
  return useMemo(() => {
    if (!sourceColors) return hunkColors
    const out: LineColors = new Map(hunkColors)
    for (const g of gaps) {
      for (const l of [...g.top, ...g.bottom]) {
        const c = sourceColors[l.new! - 1]
        out.set(l, { old: c, new: c })
      }
    }
    return out
  }, [hunkColors, sourceColors, gaps])
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
  const colors = useColors(file, source, views ?? NO_GAPS)
  const [sx, setSx] = useState({ old: 0, new: 0 })
  const bars = useRef<Record<string, HTMLDivElement | null>>({})
  const [selecting, setSelecting] = useState<Side | null>(null)
  const split = layout === 'split'

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
  let chunk: ReactNode[] = []
  let lines = 0
  const flush = (): void => {
    if (chunk.length === 0) return
    body.push(
      <div key={`chunk:${body.length}`} className="diff-chunk" style={{ containIntrinsicSize: `auto ${lines * 20}px` }}>
        {chunk}
      </div>
    )
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

  const pushRows = (prefix: string, lineRun: DiffLine[]): void => {
    rowsOf(lineRun, layout).forEach((r, ri) => {
      const key = `${prefix}:${ri}`
      const oldN = r.old?.old ?? null
      const newN = r.new?.new ?? null
      if (split) {
        chunk.push(
          <div key={key} className="diff-row split">
            <div className={`mark ${r.old ? r.old.kind : 'empty'}`}>{marker('old', oldN)}</div>
            <div className={`num ${r.old ? r.old.kind : 'empty'}`}>{oldN ?? ''}</div>
            {r.old ? code(r.old, 'old') : <div className="code empty" />}
            <div className={`mark ${r.new ? r.new.kind : 'empty'}`}>{marker('new', newN)}</div>
            <div className={`num ${r.new ? r.new.kind : 'empty'}`}>{newN ?? ''}</div>
            {r.new ? code(r.new, 'new') : <div className="code empty" />}
          </div>
        )
      } else {
        const line = (r.old ?? r.new)!
        const side: Side = line.kind === 'del' ? 'old' : 'new'
        chunk.push(
          <div key={key} className="diff-row unified">
            <div className={`mark ${line.kind}`}>{marker(side, side === 'old' ? oldN : newN) ?? (line.kind === 'context' ? marker('old', oldN) : null)}</div>
            <div className={`num ${line.kind}`}>{line.old ?? ''}</div>
            <div className={`num ${line.kind}`}>{line.new ?? ''}</div>
            {code(line, side)}
          </div>
        )
      }
      lines++
      for (const c of cardsAt('old', oldN)) chunk.push(cardRow(c, 'old'))
      for (const c of cardsAt('new', newN)) chunk.push(cardRow(c, 'new'))
      if (lines >= CHUNK) flush()
    })
  }

  // Each hunk, after the lines shown before it; then the lines shown after the last one.
  for (let hi = 0; hi <= file.hunks.length; hi++) {
    const g = views?.[hi]
    if (g) pushRows(`t${hi}`, g.top)
    const row = expander(g, hi)
    if (row) {
      chunk.push(row)
      lines++
    }
    if (g) pushRows(`b${hi}`, g.bottom)
    if (hi < file.hunks.length) pushRows(`${hi}`, file.hunks[hi].lines)
  }
  flush()

  const shownLines = [...file.hunks.flatMap((h) => h.lines), ...(views ?? []).flatMap((g) => [...g.top, ...g.bottom])]
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
    <section className="diff-file" data-file={file.path}>
      <div className="diff-file-head" onClick={() => props.onToggleFile(file.path)}>
        <button
          className="diff-chevron"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFile(file.path)
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="diff-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.status === 'added' && <span className="diff-chip">new</span>}
        {file.status === 'deleted' && <span className="diff-chip">deleted</span>}
        <span className={`diff-chip state-${file.state}`}>{STATE_NAMES[file.state]}</span>
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
      </div>
      {!collapsed &&
        (file.binary ? (
          <p className="muted diff-note">Binary file, not shown.</p>
        ) : file.hunks.length === 0 ? (
          <p className="muted diff-note">No changes to the content.</p>
        ) : (
          <>
            <div
              className={`diff-body ${layout}`}
              data-sel={selecting ?? undefined}
              style={{ '--sx-old': `${sx.old}px`, '--sx-new': `${sx.new}px` } as CSSProperties}
              onMouseDown={(e) => {
                const cell = (e.target as HTMLElement).closest<HTMLElement>('.code[data-side]')
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
            <div className={`diff-hbar ${layout}${overflows ? '' : ' idle'}`}>
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
            </div>
          </>
        ))}
    </section>
  )
})

const NO_GAPS: GapView[] = []

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

const FOLDER_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

/** A page of text. */
const FILE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6M8 13h8M8 17h8" />
  </svg>
)

/** A window with an arrow out of it. */
const EDITOR_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
)

const icon = (d: string, size: number): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

/** The expanders' buttons: up for the top of a gap, down for its bottom, up and down for all of it. */
const EXPAND_ICONS = {
  top: icon('M6 15l6-6 6 6', 11),
  all: icon('M7 15l5 5 5-5M7 9l5-5 5 5', 14),
  bottom: icon('M6 9l6 6 6-6', 11)
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
          ▴
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
