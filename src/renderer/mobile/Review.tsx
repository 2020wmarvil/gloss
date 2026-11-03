// A review session on the phone (SPEC → Remote and mobile → Reviews; docs/mocks/mobile-diff.html):
// the desktop's review session, as a file list, one file's diff, the review's threads and a range sheet.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, ChevronUp, Ellipsis, FileCode, FileMinus, FilePlus, GitFork, MessageSquare, MessageSquareReply, ScanSearch, X } from 'lucide-react'
import type { GlossEvent } from '@shared/ipc'
import { perforceRange } from '@shared/perforce'
import { expandable, gapsOf, isFirstPass, linesOf, withoutFindings, type DiffFile, type LineAnchor, type Location, type ReviewDiff, type ReviewRange, type ReviewRefs, type Side } from '@shared/review'
import type { Thread } from '@shared/types'
import { DiffView, cardOpen, type Card } from '../src/DiffView'
import { expand, NO_EXPANSION, revealing, type Expansion } from '../src/diffContext'
import { errorText } from '../src/errors'
import { rangeChoices, type Option } from '../src/RangePicker'
import { useReviewSources, type Sources } from '../src/reviewSources'
import { inDiffOrder, isLineThread, KIND_NAMES, kindOf, locations as threadLocations, shownLine, titleOf, type LineThread, type ThreadKind } from '../src/reviewThreads'
import { threadSummaries } from '../src/ThreadsOverview'
import type { OpenView } from './usePhone'

/** How long the diff waits for an agent's edits to settle before it is read again. */
const REFRESH_DELAY = 300

/** The review state the phone keeps for the open review session, shared by its screens. */
export type ReviewState = {
  diff: ReviewDiff | null
  error: string | null
  sources: Sources
  locations: Map<string, Location>
  /** The lines shown around each file's hunks, by path, with the lines threads are at. */
  expansions: Record<string, Expansion>
  onExpand(path: string, how: Parameters<typeof expand>[1]): void
  /** Cards collapsed to their marker (or, for resolved threads, expanded). */
  toggled: Set<string>
  onToggleCard(threadId: string): void
  refs: ReviewRefs | null
  loadRefs(): void
  setRange(range: ReviewRange): Promise<void>
}

/** The open review's diff, read when it opens, after the agent's edits and turns, and on return to the app. */
export function useReview(open: OpenView | null, online: boolean): ReviewState | null {
  const review = open?.session.review
  const id = review ? open!.session.id : null
  const [state, setState] = useState<{ id: string; diff: ReviewDiff | null; error: string | null } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shown = useRef(id)
  shown.current = id

  const refresh = useCallback((now = false) => {
    const sessionId = shown.current
    if (!sessionId) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      window.gloss.sessions.reviewDiff(sessionId).then(
        (diff) => { if (shown.current === sessionId) setState({ id: sessionId, diff, error: null }) },
        (err: unknown) => {
          if (shown.current === sessionId) setState((s) => ({ id: sessionId, diff: s?.id === sessionId ? s.diff : null, error: errorText(err) }))
        }
      )
    }, now ? 0 : REFRESH_DELAY)
  }, [])

  useEffect(() => {
    if (id && online) refresh(true)
  }, [id, online, refresh])
  useEffect(() => window.gloss.onEvent((event: GlossEvent) => {
    if (!shown.current) return
    // The agent may have changed files: the diff shows its edits as it makes them.
    if (event.type === 'toolCall' && event.toolCall.sessionId === shown.current && event.toolCall.status === 'completed') refresh()
    else if (event.type === 'turnEnd' && event.sessionId === shown.current) refresh()
  }), [refresh])
  useEffect(() => {
    const onShow = (): void => { if (document.visibilityState === 'visible') refresh(true) }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [refresh])

  const diff = state && state.id === id ? state.diff : null
  const threads = open?.threads ?? NO_THREADS
  const { sources, read } = useReviewSources(id, review, diff, threads)
  const locs = useMemo(() => threadLocations(threads, diff, sources), [threads, diff, sources])

  // Another review or range is another diff: nothing shown beyond its hunks yet.
  const rangeKey = review ? `${id}\0${review.baseRef}\0${review.headRef ?? ''}` : ''
  const [expansions, setExpansions] = useState<Record<string, Expansion>>({})
  const [toggled, setToggled] = useState(() => new Set<string>())
  useEffect(() => setExpansions({}), [rangeKey])
  useEffect(() => setToggled(new Set()), [id])
  const onExpand = useCallback((path: string, how: Parameters<typeof expand>[1]) => {
    setExpansions((e) => ({ ...e, [path]: expand(e[path] ?? NO_EXPANSION, how) }))
    if (sources[path] === undefined) read(path)
  }, [sources, read])
  const onToggleCard = useCallback((threadId: string) => setToggled((s) => {
    const next = new Set(s)
    if (!next.delete(threadId)) next.add(threadId)
    return next
  }), [])

  const [refs, setRefs] = useState<ReviewRefs | null>(null)
  const loadRefs = useCallback(() => {
    const sessionId = shown.current
    if (sessionId) window.gloss.sessions.reviewRefs(sessionId).then((r) => { if (shown.current === sessionId) setRefs(r) }, () => undefined)
  }, [])
  useEffect(() => {
    setRefs(null)
    if (id && online) loadRefs()
  }, [id, online, loadRefs])

  const setRange = useCallback(async (range: ReviewRange) => {
    const sessionId = shown.current
    if (!sessionId) return
    const next = await window.gloss.sessions.setReviewRange(sessionId, range.baseRef, range.headRef ?? null)
    if (shown.current === sessionId) setState({ id: sessionId, diff: next, error: null })
  }, [])

  if (!id) return null
  return {
    diff, error: state?.id === id ? state.error : null, sources, locations: locs, expansions, onExpand, toggled, onToggleCard,
    refs, loadRefs, setRange
  }
}

const NO_THREADS: Thread[] = []

/** The open line threads, in file and line order. */
function openThreadsOf(open: OpenView, r: ReviewState): LineThread[] {
  return inDiffOrder(open.threads, r.diff, r.locations).filter((t) => t.resolvedAt === undefined)
}

/** The thread cards of one file, as the desktop's diff shows them. */
function cardsOf(open: OpenView, r: ReviewState, path: string, running: string[]): Card[] {
  const summaries = new Map(threadSummaries(open).map((s) => [s.thread.id, s]))
  return inDiffOrder(open.threads, r.diff, r.locations).filter((t) => t.anchor.file === path).map((t) => {
    const s = summaries.get(t.id)
    return {
      thread: t,
      kind: kindOf(t),
      title: titleOf(t, open.messages),
      body: t.finding?.body ?? null,
      replies: s?.replies ?? 0,
      lastActivity: s?.lastActivity ?? t.createdAt,
      running: running.includes(t.id),
      location: r.locations.get(t.id) ?? { kind: 'gone' },
      resolved: t.resolvedAt !== undefined
    }
  })
}

const KIND_ORDER: ThreadKind[] = ['bug', 'suggestion', 'nit', 'you']
const STATE_NAMES: Record<DiffFile['state'], string> = { committed: 'committed', uncommitted: 'uncommitted', both: 'committed + uncommitted' }

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function folderOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}

/** The first line of an agent message, without its findings or markdown marks. */
function preview(text: string): string {
  return withoutFindings(text).split('\n').find((l) => l.trim())?.replace(/[*_`#>]/g, '').trim() ?? ''
}

/** The header's second line: the agent, and a draft's state or the open threads. */
export function reviewSubtitle(open: OpenView, agentName: string): string {
  if (open.session.draft) return `${agentName} · draft`
  const n = open.threads.filter((t) => isLineThread(t) && t.resolvedAt === undefined).length
  return n > 0 ? `${agentName} · ${n} open` : agentName
}

// The file list

export function ReviewFiles(props: {
  open: OpenView
  review: ReviewState
  agentName: string
  offline: boolean
  onBack(): void
  onThreads(): void
  onGeneral(): void
  onFile(path: string): void
  onRunReview(): void
}): React.JSX.Element {
  const { open, review } = props
  const [range, setRange] = useState(false)
  const files = review.diff?.files ?? []
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  const lineThreads = open.threads.filter(isLineThread)
  const openCount = lineThreads.filter((t) => t.resolvedAt === undefined).length
  const lastAgent = [...open.messages].reverse().find((m) => m.threadId === null && m.role === 'agent')
  const ran = open.messages.some((m) => m.threadId === null && m.role === 'user' && isFirstPass(m.text))
  const choices = open.session.review ? rangeChoices(open.session.review, review.diff, review.refs) : null
  return (
    <>
      <div className="m-hdr">
        <button className="m-back" onClick={props.onBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="m-hdr-t"><b>{open.session.title}</b><small>{reviewSubtitle(open, props.agentName)}</small></div>
        <button className="m-ib" onClick={props.onThreads} aria-label="Threads">
          <MessageSquare size={18} />{openCount > 0 && <span className="m-badge">{openCount}</span>}
        </button>
      </div>
      {choices && (
        <button className="m-range" onClick={() => { review.loadRefs(); setRange(true) }}>
          <span className="m-chip"><span className="m-lbl">{open.session.review && perforceRange(open.session.review.baseRef) ? 'Changes' : 'Base'}</span>{choices.baseCurrent}</span>
          {choices.headOptions.length > 0 && <ArrowRight size={14} className="m-faint" />}
          {choices.headOptions.length > 0 && <span className="m-chip"><span className="m-lbl">Review</span>{choices.headCurrent}</span>}
        </button>
      )}
      <div className="m-body m-scroll">
        <button className="m-gen" onClick={props.onGeneral}>
          <MessageSquare size={16} />
          <span className="m-row-main">
            <b>General conversation</b>
            <small>{lastAgent ? preview(lastAgent.text) : 'Ask about the change, or have the agent review it.'}</small>
          </span>
          <ChevronRight size={16} />
        </button>
        {review.error && <p className="m-error" role="alert">Couldn&apos;t read the diff: {review.error}</p>}
        {!review.diff && !review.error && <p className="m-empty">Reading the diff…</p>}
        {review.diff && files.length === 0 && <p className="m-empty">Nothing to review: no changes in this selection.</p>}
        {files.length > 0 && (
          <div className="m-sec">{files.length} {files.length === 1 ? 'file' : 'files'} · <span className="add">+{additions}</span> <span className="del">−{deletions}</span></div>
        )}
        {files.map((f, index) => {
          const here = lineThreads.filter((t) => t.anchor.file === f.path && t.resolvedAt === undefined)
          const worst = KIND_ORDER.find((k) => here.some((t) => kindOf(t) === k))
          return (
            <Fragment key={f.path}>
            {f.outside && !files[index - 1]?.outside && <div className="m-sec">Outside this folder</div>}
            <button key={f.path} className="m-frow" onClick={() => props.onFile(f.path)}>
              {f.status === 'added' ? <FilePlus size={16} /> : f.status === 'deleted' ? <FileMinus size={16} /> : <FileCode size={16} />}
              <span className="m-row-main">
                <b>{fileName(f.path)}</b>
                <small>{[folderOf(f.displayPath ?? f.path), f.status === 'added' ? 'new' : f.status === 'deleted' ? 'deleted' : null, f.perforce ? f.perforce.opened ? `Opened (${f.perforce.change})` : 'Not opened' : STATE_NAMES[f.state]].filter(Boolean).join(' · ')}</small>
              </span>
              {worst && <span className="m-tc"><span className={`m-mkr kind-${worst}`} />{here.length}</span>}
              <span className="m-cnt"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
              <ChevronRight size={16} />
            </button>
            </Fragment>
          )
        })}
        <div className="m-fab-space" />
      </div>
      <div className="m-foot">
        <button
          className={`m-btn${ran ? '' : ' m-pri'}`}
          disabled={props.offline || open.turn !== null || files.length === 0}
          onClick={props.onRunReview}
        >
          <ScanSearch size={16} />{ran ? 'Run review again' : 'Run review'}
        </button>
      </div>
      {range && choices && open.session.review && (
        <RangeSheet range={open.session.review} choices={choices} onClose={() => setRange(false)} onChange={review.setRange} />
      )}
    </>
  )
}

/** The desktop's Base and Review dropdowns as one sheet (SPEC → Review sessions → What is reviewed). */
function RangeSheet(props: {
  range: ReviewRange
  choices: ReturnType<typeof rangeChoices>
  onClose(): void
  onChange(range: ReviewRange): Promise<void>
}): React.JSX.Element {
  const { range, choices } = props
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const head = range.headRef ?? null
  const pick = (next: ReviewRange): void => {
    setError(null)
    props.onChange(next).then(props.onClose, (e: unknown) => setError(errorText(e)))
  }
  const needle = filter.trim().toLowerCase()
  const matching = (options: Option[]): Option[] =>
    needle ? options.filter((o) => `${o.label} ${o.sha ?? ''} ${o.value ?? ''}`.toLowerCase().includes(needle)) : options
  const list = (options: Option[], selected: string | null, onPick: (value: string | null) => void): React.ReactNode =>
    matching(options).map((o, i, shown) => (
      <div key={`${o.group}:${o.value ?? ''}`}>
        {(i === 0 || shown[i - 1].group !== o.group) && <div className="m-sec">{o.group}</div>}
        <button className={`m-opt${o.value === selected ? ' on' : ''}`} onClick={() => { if (o.value !== selected) onPick(o.value) }}>
          <span className="m-opt-text">
            <b>{o.sha && o.group === 'Commits' && <code className="m-sha">{o.sha.slice(0, 7)}</code>}{o.label}{o.isDefault && <span className="m-dtag">default</span>}</b>
            {o.detail && <small>{o.detail}</small>}
          </span>
          {o.value === selected && <Check size={18} />}
        </button>
      </div>
    ))
  return (
    <>
      <div className="m-dim" onClick={props.onClose} />
      <div className="m-sheet m-sheet-tall" role="dialog" aria-label="Range">
        <div className="m-grab" />
        <div className="m-sheet-head">
          <h4>Range</h4>
          {choices.reset !== null && <button className="m-dbtn" onClick={() => pick({ baseRef: choices.reset! })}>Reset</button>}
        </div>
        <input className="m-filter" placeholder="Filter changes" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <p className="m-error" role="alert">{error}</p>}
        <div className="m-sheet-scroll">
          <h4 className="m-sheet-sub">{perforceRange(range.baseRef) ? 'Changes' : 'Base'}</h4>
          {list(choices.baseOptions, range.baseRef, (value) => value !== null && pick({ baseRef: value, ...(head !== null ? { headRef: head } : {}) }))}
          {choices.headOptions.length > 0 && <h4 className="m-sheet-sub">Review</h4>}
          {list(choices.headOptions, head, (value) => pick({ baseRef: range.baseRef, ...(value !== null ? { headRef: value } : {}) }))}
        </div>
      </div>
    </>
  )
}

// One file

const WRAP_KEY = 'gloss.phone.review.wrap'
const COMMENTS_KEY = 'gloss.phone.review.comments'
const NUMBERS_KEY = 'gloss.phone.review.numbers'

function useStoredFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  })
  return [value, (v) => { localStorage.setItem(key, v ? '1' : '0'); setValue(v) }]
}

export function ReviewFile(props: {
  open: OpenView
  review: ReviewState
  path: string
  /** The threads with a running turn. */
  busy: string[]
  forkDisabled?: string
  offline: boolean
  onBack(): void
  onFile(path: string): void
  onOpenThread(threadId: string): void
  /** Opens a new thread on a line, or the existing one there. */
  onReply(anchor: LineAnchor, fork: boolean): void
}): React.JSX.Element {
  const { open, review, path } = props
  const files = review.diff?.files ?? []
  const index = files.findIndex((f) => f.path === path)
  const file = files[index]
  const [wrap, setWrap] = useStoredFlag(WRAP_KEY, false)
  const [comments, setComments] = useStoredFlag(COMMENTS_KEY, true)
  const [numbers, setNumbers] = useStoredFlag(NUMBERS_KEY, true)
  const [menu, setMenu] = useState(false)
  const [picked, setPicked] = useState<{ side: Side; line: number } | null>(null)
  const [stepped, setStepped] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => setPicked(null), [path])

  const cards = useMemo(() => cardsOf(open, review, path, props.busy), [open, review, path, props.busy])
  const openThreads = openThreadsOf(open, review)
  const position = openThreads.findIndex((t) => t.id === stepped)

  // The lines threads are at stay shown when they are outside the hunks.
  const source = review.sources[path]
  const gaps = file && source && expandable(file) ? gapsOf(file.hunks) : null
  const expansion = review.expansions[path] ?? NO_EXPANSION
  const shownExpansion = gaps && source && cards.length > 0
    ? revealing(expansion, gaps, source.length, cards.map((c) => ({ side: c.thread.anchor.side, location: c.location })))
    : expansion

  /** Goes to the next (1) or previous (-1) open thread, in this file or another, and brings its card into view. */
  function step(by: 1 | -1): void {
    if (openThreads.length === 0) return
    const i = position < 0 ? (by > 0 ? 0 : openThreads.length - 1) : (position + by + openThreads.length) % openThreads.length
    const t = openThreads[i]
    setStepped(t.id)
    const card = cards.find((c) => c.thread.id === t.id)
    if (card && comments && !cardOpen(card, review.toggled)) review.onToggleCard(t.id)
    if (t.anchor.file !== path) props.onFile(t.anchor.file)
  }
  useEffect(() => {
    if (!stepped) return
    const el = scroller.current?.querySelector<HTMLElement>(`.thread-card[data-thread="${CSS.escape(stepped)}"]`) ??
      scroller.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(stepped)}"]`)
    el?.scrollIntoView?.({ block: 'center' })
  }, [stepped, path, comments])

  const anchor = picked && file ? lineAnchor(file, picked.side, picked.line, source) : null
  return (
    <>
      <div className="m-hdr">
        <button className="m-back" onClick={props.onBack}><ArrowLeft size={18} />Files</button>
        <div className="m-hdr-t m-ctr">
          <b>{fileName(path)}</b>
          {file && <small><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span> · {index + 1} of {files.length}</small>}
        </div>
        <button className="m-ib" aria-label="Previous file" disabled={index <= 0} onClick={() => props.onFile(files[index - 1].path)}><ChevronUp size={18} /></button>
        <button className="m-ib" aria-label="Next file" disabled={index < 0 || index >= files.length - 1} onClick={() => props.onFile(files[index + 1].path)}><ChevronDown size={18} /></button>
        <button className="m-ib" aria-label="View options" onClick={() => setMenu(true)}><Ellipsis size={18} /></button>
      </div>
      <div className={`m-body m-scroll m-diff${wrap ? ' wrap' : ''}${numbers ? '' : ' no-nums'}`} ref={scroller}>
        {!file ? (
          <p className="m-empty">{review.diff ? 'This file is no longer changed.' : 'Reading the diff…'}</p>
        ) : (
          <DiffView
            files={[file]}
            layout="unified"
            cards={cards}
            active={anchor ? { threadId: null, file: path, side: anchor.side, start: anchor.start, end: anchor.end } : null}
            showComments={comments}
            toggled={review.toggled}
            expandedFiles={new Set([path])}
            sources={review.sources}
            expansions={{ [path]: shownExpansion }}
            onToggleFile={() => {}}
            onExpand={review.onExpand}
            onOpenFile={() => {}}
            onToggleCard={review.onToggleCard}
            onOpenThread={props.onOpenThread}
            bare
            // One line at a time: a tap picks it, another tap on it clears it.
            onTapLine={(side, line) => setPicked((p) => p && p.side === side && p.line === line ? null : { side, line })}
          />
        )}
      </div>
      {anchor ? (
        <div className="m-selbar">
          <button className="m-act" onClick={() => setPicked(null)} aria-label="Dismiss"><X size={16} /></button>
          <button className="m-act" disabled={!!props.forkDisabled || props.offline} title={props.forkDisabled} onClick={() => { setPicked(null); props.onReply(anchor, true) }}><GitFork size={16} />Fork</button>
          <button className="m-act m-pri" disabled={props.offline} onClick={() => { setPicked(null); props.onReply(anchor, false) }}>
            <MessageSquareReply size={16} />Reply on {anchor.start}{anchor.side === 'old' ? ' (old)' : ''}
          </button>
        </div>
      ) : openThreads.length > 0 && (
        <div className="m-foot m-stepbar">
          <span className="m-grow">{position >= 0 ? `${position + 1} of ${openThreads.length} open` : `${openThreads.length} open`}</span>
          <button className="m-ib" aria-label="Previous open thread" onClick={() => step(-1)}><ChevronUp size={18} /></button>
          <button className="m-ib" aria-label="Next open thread" onClick={() => step(1)}><ChevronDown size={18} /></button>
        </div>
      )}
      {menu && (
        <>
          <div className="m-dim" onClick={() => setMenu(false)} />
          <div className="m-sheet" role="dialog" aria-label="View options">
            <div className="m-grab" />
            <h4>{fileName(path)}</h4>
            <Toggle label="Wrap lines" on={wrap} onChange={setWrap} />
            <Toggle label="Line numbers" on={numbers} onChange={setNumbers} />
            {file && expandable(file) && source !== null && (
              <Toggle label="Entire file" on={expansion.full} onChange={() => review.onExpand(path, 'full')} />
            )}
            <Toggle label="Show comments" on={comments} onChange={setComments} />
          </div>
        </>
      )}
    </>
  )
}

/** A line of the diff (or of the lines shown around it) as a thread's anchor. */
function lineAnchor(file: DiffFile, side: Side, line: number, source: string[] | null | undefined): LineAnchor | null {
  const lines = linesOf(file, side, line, line, source)
  if (!lines) return null
  return { kind: 'line', file: file.path, side, start: line, end: line, text: lines[0].trim() || lines[0], lines }
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange(v: boolean): void }): React.JSX.Element {
  return (
    <button className="m-kv m-kv-btn" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="m-k m-ink">{label}</span>
      <span className={`m-switch${on ? ' on' : ''}`} />
    </button>
  )
}

// The review's threads

type Filter = 'open' | 'resolved' | 'all' | 'queue'

export function ReviewThreads(props: {
  open: OpenView
  review: ReviewState
  busy: string[]
  onBack(): void
  onGeneral(): void
  onOpen(t: Thread): void
  /** The phone's Queue tab, as in a session. */
  queue: React.ReactNode
}): React.JSX.Element {
  const { open, review } = props
  const [filter, setFilter] = useState<Filter>('open')
  const all = inDiffOrder(open.threads, review.diff, review.locations)
  const resolved = all.filter((t) => t.resolvedAt !== undefined)
  const unresolved = all.filter((t) => t.resolvedAt === undefined)
  const shown = filter === 'open' ? unresolved : filter === 'resolved' ? resolved : all
  const summaries = new Map(threadSummaries(open).map((s) => [s.thread.id, s]))
  const lastAgent = [...open.messages].reverse().find((m) => m.threadId === null && m.role === 'agent')
  const general = open.messages.filter((m) => m.threadId === null && !(m.role === 'user' && isFirstPass(m.text))).length
  return (
    <>
      <div className="m-hdr">
        <button className="m-back" onClick={props.onBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="m-hdr-t"><b>Threads</b><small>{open.session.title}</small></div>
      </div>
      <div className="m-tabs">
        <button aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open {unresolved.length}</button>
        <button aria-pressed={filter === 'resolved'} onClick={() => setFilter('resolved')}>Resolved {resolved.length}</button>
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {all.length}</button>
        <button aria-pressed={filter === 'queue'} onClick={() => setFilter('queue')}>Queue {open.queue.items.length}</button>
      </div>
      <div className="m-body m-scroll">
        {filter === 'queue' ? props.queue : (
          <>
            <button className="m-gen" onClick={props.onGeneral}>
              <MessageSquare size={16} />
              <span className="m-row-main">
                <b>General conversation</b>
                <small>{lastAgent ? preview(lastAgent.text) : 'Ask about the change, or have the agent review it.'}</small>
              </span>
              {general > 0 && <span className="m-when">{general}</span>}
            </button>
            {shown.length === 0 && <p className="m-empty">{filter === 'resolved' ? 'No resolved threads.' : 'No threads yet. Tap a line of a file to reply on it, or run a review.'}</p>}
            {shown.map((t, i) => {
              const at = review.locations.get(t.id)
              const s = summaries.get(t.id)
              const kind = kindOf(t)
              return (
                <div key={t.id}>
                  {(i === 0 || shown[i - 1].anchor.file !== t.anchor.file) && (
                    <div className="m-sec">{fileName(t.anchor.file)}{at?.kind === 'gone' ? ' · no longer changed' : ''}</div>
                  )}
                  <button className="m-row m-trow" onClick={() => props.onOpen(t)}>
                    <span className={`m-mkr kind-${t.resolvedAt !== undefined ? 'resolved' : kind}`} />
                    <span className="m-row-main">
                      <b className="m-wrap">{titleOf(t, open.messages)}</b>
                      <small>
                        {shownLine(t, at)}{t.anchor.end > t.anchor.start && at?.kind === 'found' ? `–${at.end}` : ''} · {KIND_NAMES[kind]}
                        {props.busy.includes(t.id) ? <> · <span className="s-working">working</span></> : ` · ${s?.replies ?? 0} ${(s?.replies ?? 0) === 1 ? 'reply' : 'replies'}`}
                        {at?.kind === 'outdated' ? ' · Outdated' : ''}{t.resolvedAt !== undefined ? ' · Resolved' : ''}
                      </small>
                    </span>
                  </button>
                </div>
              )
            })}
          </>
        )}
      </div>
    </>
  )
}

// A line thread's head

/** Above a line thread's messages: its kind, `file:lines`, the lines (struck through once outdated) and the finding. */
export function LineQuote({ thread, anchor, location }: { thread?: LineThread; anchor: LineAnchor; location?: Location }): React.JSX.Element {
  const kind = thread ? kindOf(thread) : 'you'
  const outdated = location?.kind === 'outdated' || location?.kind === 'gone'
  const start = location?.kind === 'found' ? location.start : anchor.start
  return (
    <div className="m-lq">
      <div className="m-lqh">
        <span className={`kind-chip kind-${kind}`}>{KIND_NAMES[kind]}</span>
        <code>{anchor.file}:{start}{anchor.lines.length > 1 ? `–${start + anchor.lines.length - 1}` : ''}{anchor.side === 'old' ? ' (old)' : ''}</code>
        {outdated && <span className="tag-outdated">Outdated</span>}
      </div>
      <div className={`m-lq-lines${outdated ? ' outdated' : ''}`}>
        {anchor.lines.map((l, i) => (
          <div key={i}><span>{start + i}</span><code>{l || ' '}</code></div>
        ))}
      </div>
      {thread?.finding && (
        <div className="m-lq-finding"><b>{thread.finding.title}</b>{thread.finding.body && thread.finding.body !== thread.finding.title && <p>{thread.finding.body}</p>}</div>
      )}
    </div>
  )
}
