// The review header's two dropdowns: the base and the reviewed commit (SPEC → Review
// sessions → What is reviewed).
import { useEffect, useRef, useState } from 'react'
import { isCommitId, type ReviewDiff, type ReviewRange, type ReviewRefs } from '@shared/review'
import { ago } from './Sidebar'
import { ArrowRight, ChevronDown } from 'lucide-react'

/**
 * One choice in a dropdown; `value` null is the working tree. `sha` shows (and links to)
 * a commit. `isDefault` marks what a new review starts with.
 */
type Option = { value: string | null; label: string; sha?: string; detail?: string; group: string; isDefault?: boolean }

type PickerProps = {
  label: string
  /** What the button shows. */
  current: string
  options: Option[]
  /** The chosen option's value. */
  selected: string | null
  /** A commit's GitHub page, or null. */
  commitUrl(sha: string): string | null
  /** Called when the menu opens, so the options can be refreshed. */
  onOpen(): void
  onPick(value: string | null): void
}

/** A button that opens a filterable list of commits. */
function Picker(props: PickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const box = useRef<HTMLSpanElement>(null)

  // Clicks elsewhere and Escape close it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? props.options.filter((o) => `${o.label} ${o.sha ?? ''} ${o.value ?? ''}`.toLowerCase().includes(needle))
    : props.options
  const rows: React.ReactNode[] = []
  shown.forEach((o, i) => {
    if (i === 0 || shown[i - 1].group !== o.group) rows.push(<div key={`g:${o.group}`} className="range-group">{o.group}</div>)
    const pick = (): void => {
      setOpen(false)
      if (o.value !== props.selected) props.onPick(o.value)
    }
    const url = o.sha ? props.commitUrl(o.sha) : null
    // A row rather than a button, so the commit's link can sit inside it.
    rows.push(
      <div
        key={`o:${o.value ?? ''}`}
        role="menuitemradio"
        tabIndex={0}
        aria-checked={o.value === props.selected}
        className={`range-option${o.value === props.selected ? ' on' : ''}`}
        onClick={pick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            pick()
          }
        }}
      >
        <span className="range-label">{o.label}</span>
        {o.isDefault && <span className="range-default">default</span>}
        {(o.sha || o.detail) && (
          <span className="range-detail">
            {o.sha &&
              (url ? (
                <a href={url} target="_blank" rel="noreferrer" title="Open on GitHub" onClick={(e) => e.stopPropagation()}>
                  {short(o.sha)}
                </a>
              ) : (
                short(o.sha)
              ))}
            {o.sha && o.detail && ' · '}
            {o.detail}
          </span>
        )}
      </div>
    )
  })

  return (
    <span className="range-picker" ref={box}>
      <button
        className="range-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${props.label}: ${props.current}`}
        onClick={() => {
          if (!open) {
            setFilter('')
            props.onOpen()
          }
          setOpen(!open)
        }}
      >
        <span className="range-name">{props.label}</span>
        <span className="range-current">{props.current}</span>
        <ChevronDown className="caret" size={14} />
      </button>
      {open && (
        <div className="menu range-menu" role="menu" aria-label={props.label}>
          <input
            className="range-filter"
            autoFocus
            placeholder="Filter commits"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="range-options">{rows.length > 0 ? rows : <p className="muted range-none">No match.</p>}</div>
        </div>
      )}
    </span>
  )
}

const short = (sha: string): string => sha.slice(0, 7)

type Props = {
  range: ReviewRange
  diff: ReviewDiff | null
  /** Null until listed. */
  refs: ReviewRefs | null
  onRefresh(): void
  onChange(range: ReviewRange): void
}

/** Base → Review: what the diff compares. */
export function RangePicker(props: Props): React.JSX.Element {
  const { range, diff, refs } = props
  const commits = refs?.commits ?? []
  const subject = (sha: string): string | undefined => commits.find((c) => c.sha === sha)?.subject
  const commitOptions = (group: string): Option[] =>
    commits.map((c) => ({ value: c.sha, label: c.subject, sha: c.sha, detail: ago(c.at), group }))
  const commitUrl = (sha: string): string | null => (refs?.repoUrl ? `${refs.repoUrl}/commit/${sha}` : null)

  const defaultBase = refs?.defaultBase ?? null
  const baseOptions: Option[] = [
    ...(refs?.bases ?? []).map((b) => ({
      value: b.ref,
      label: `Merge base with ${b.ref}`,
      sha: b.sha,
      group: 'Where the branch left',
      isDefault: b.ref === defaultBase
    })),
    ...commitOptions('Commits')
  ]
  const baseCurrent = isCommitId(range.baseRef)
    ? `${short(range.baseRef)}${subject(range.baseRef) ? ` ${subject(range.baseRef)}` : ''}`
    : `merge base with ${range.baseRef}${diff ? ` · ${short(diff.base)}` : ''}`

  const head = range.headRef ?? null
  const headOptions: Option[] = [
    { value: null, label: 'Working tree, including uncommitted', group: 'Latest', isDefault: true },
    { value: 'HEAD', label: 'HEAD', sha: commits[0]?.sha, group: 'Latest' },
    ...commitOptions('Commits')
  ]
  const headCurrent =
    head === null
      ? 'working tree'
      : head === 'HEAD'
        ? `HEAD${diff ? ` · ${short(diff.head)}` : ''}`
        : `${short(head)}${subject(head) ? ` ${subject(head)}` : ''}`

  return (
    <span className="range">
      <Picker
        label="Base"
        current={baseCurrent}
        options={baseOptions}
        selected={range.baseRef}
        commitUrl={commitUrl}
        onOpen={props.onRefresh}
        onPick={(value) => value !== null && props.onChange({ baseRef: value, ...(head !== null ? { headRef: head } : {}) })}
      />
      <ArrowRight className="range-arrow" size={13} />
      <Picker
        label="Review"
        current={headCurrent}
        options={headOptions}
        selected={head}
        commitUrl={commitUrl}
        onOpen={props.onRefresh}
        onPick={(value) => props.onChange({ baseRef: range.baseRef, ...(value !== null ? { headRef: value } : {}) })}
      />
      {defaultBase !== null && (range.baseRef !== defaultBase || head !== null) && (
        <button
          className="range-reset"
          title={`Back to the default: merge base with ${defaultBase} → working tree`}
          onClick={() => props.onChange({ baseRef: defaultBase })}
        >
          Reset
        </button>
      )}
    </span>
  )
}
