import { useEffect, useRef, useState, type ReactNode } from 'react'
import { folderName } from '@shared/paths'
import type { SearchRequest, SearchResponse, SearchResult } from '@shared/search'
import { errorText } from './errors'
import { Select } from './Select'
import { Bot, Search, Terminal, User } from 'lucide-react'

type Props = {
  sessionId: string | null
  cwd: string | null
  onClose(): void
  onOpen(result: SearchResult): Promise<void>
}

const KIND_NAMES = { user: 'You', agent: 'Agent', tool: 'Tool output' } as const
const KIND_ICONS = { user: <User />, agent: <Bot />, tool: <Terminal /> } as const

/** Results grouped by session, in the order the sessions first appear. */
export function groupResults(results: SearchResult[]): { sessionId: string; title: string; cwd: string; results: SearchResult[] }[] {
  const groups = new Map<string, { sessionId: string; title: string; cwd: string; results: SearchResult[] }>()
  for (const r of results) {
    const group = groups.get(r.sessionId) ?? { sessionId: r.sessionId, title: r.sessionTitle, cwd: r.cwd, results: [] }
    group.results.push(r)
    groups.set(r.sessionId, group)
  }
  return [...groups.values()]
}

/**
 * A snippet as text with its matches marked (U+0001…U+0002), `inline code` shown as code
 * and **bold** markers dropped, instead of raw markdown. Never HTML.
 */
export function Snippet({ text }: { text: string }): React.JSX.Element {
  // An odd backtick count means one was cut off at the snippet's edge: keep them all as text.
  const code = (text.match(/`/g)?.length ?? 0) % 2 === 0
  const runs: { text: string; mark: boolean; code: boolean }[] = []
  let mark = false
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\u0001' || ch === '\u0002') mark = ch === '\u0001'
    else if (ch === '`' && code) inCode = !inCode
    else if (ch === '*' && text[i + 1] === '*' && !inCode) i++
    else {
      const last = runs.at(-1)
      if (last && last.mark === mark && last.code === inCode) last.text += ch
      else runs.push({ text: ch, mark, code: inCode })
    }
  }
  // Consecutive runs inside one code span stay one <code>.
  const out: ReactNode[] = []
  for (let i = 0; i < runs.length; ) {
    if (runs[i].code) {
      const parts: ReactNode[] = []
      for (; i < runs.length && runs[i].code; i++) parts.push(runs[i].mark ? <mark key={i}>{runs[i].text}</mark> : runs[i].text)
      out.push(<code key={`c${i}`}>{parts}</code>)
    } else {
      out.push(runs[i].mark ? <mark key={i}>{runs[i].text}</mark> : runs[i].text)
      i++
    }
  }
  return <span className="search-snippet">{out}</span>
}

export function SearchDialog({ sessionId, cwd, onClose, onOpen }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchRequest['scope']>('all')
  const [kind, setKind] = useState<SearchRequest['kind']>('all')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setResponse(null)
    setError(null)
    setActive(0)
    setLoading(Boolean(query.trim()))
    if (!query.trim()) return
    const timer = setTimeout(() => {
      void window.gloss.search({ query, scope, kind, ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) })
        .then((result) => { if (active) setResponse(result) })
        .catch((err: unknown) => { if (active) setError(errorText(err)) })
        .finally(() => { if (active) setLoading(false) })
    }, 150)
    return () => { active = false; clearTimeout(timer) }
  }, [query, scope, kind, sessionId, cwd])
  // Keep the highlighted result in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector('.search-result.active')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  async function choose(result: SearchResult): Promise<void> {
    setOpening(true)
    setError(null)
    try { await onOpen(result); onClose() }
    catch (err) { setError(`Couldn't open result: ${errorText(err)}`) }
    finally { setOpening(false) }
  }

  const results = response?.results ?? []
  const groups = groupResults(results)
  // The flat order the arrows move through: group by group.
  const ordered = groups.flatMap((g) => g.results)
  const count = response ? `${results.length}${response.more ? '+' : ''} ${results.length === 1 ? 'result' : 'results'}` : ''

  return (
    <div className="dialog-backdrop search-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !opening) onClose() }}>
      <div className="dialog search-dialog" role="dialog" aria-modal="true" aria-labelledby="search-title" ref={ref}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); if (!opening) onClose() }
          if (e.key === 'Tab') {
            const controls = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')]
            const first = controls[0], last = controls.at(-1)
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
          }
        }}>
        <h2 id="search-title" className="sr-only">Search conversations</h2>
        <div className="search-head">
          <label className="search-field">
            <Search aria-hidden />
            <input ref={input} aria-label="Search conversations" placeholder='Search words or "an exact phrase"' value={query} maxLength={1000}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (ordered.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : ordered.length - 1)) % ordered.length)
                }
                if (e.key === 'Enter' && ordered[active] && !loading && !opening) void choose(ordered[active])
              }} />
            <kbd title="Close">Esc</kbd>
          </label>
          <div className="search-filters">
            <Select ariaLabel="Search in" label="In" value={scope} onChange={(v) => setScope(v as SearchRequest['scope'])}
              options={[{ value: 'all', label: 'Everything' }, { value: 'project', label: 'Current project', disabled: !cwd }, { value: 'session', label: 'Current session', disabled: !sessionId }]} />
            <Select ariaLabel="Show" label="Show" value={kind} onChange={(v) => setKind(v as SearchRequest['kind'])}
              options={[{ value: 'all', label: 'All messages and tools' }, { value: 'user', label: 'Your messages' }, { value: 'agent', label: 'Agent messages' }, { value: 'tool', label: 'Tool output' }]} />
            <span className="search-count" role="status" aria-live="polite">{loading ? 'Searching…' : count}</span>
          </div>
        </div>
        {error && <p role="alert" className="dialog-error">{error}</p>}
        <div className="search-results" ref={list} aria-busy={loading || opening}>
          {!response && !loading && (
            <p className="search-empty">Enter words to search your conversations. Searches history loaded into Gloss: open other agent sessions to include them.</p>
          )}
          {response && results.length === 0 && <p className="search-empty">No matches.</p>}
          {response?.more && <p className="search-empty">Showing the first 100. Refine your search for more.</p>}
          {groups.map((g) => (
            <section key={g.sessionId} className="search-group" aria-label={g.title}>
              <div className="search-group-head">
                <b>{g.title}</b>
                <span title={g.cwd}>
                  {folderName(g.cwd)} · {g.results.length} {g.results.length === 1 ? 'result' : 'results'}
                </span>
              </div>
              {g.results.map((r) => {
                const i = ordered.indexOf(r)
                return (
                  <button className={i === active ? 'search-result active' : 'search-result'} key={`${r.sessionId}:${r.kind}:${r.id}`} disabled={opening}
                    onMouseMove={() => setActive(i)} onClick={() => void choose(r)}>
                    <span className="search-kind" aria-hidden>{KIND_ICONS[r.kind]}</span>
                    <span className="search-body">
                      <span className="search-where">{KIND_NAMES[r.kind]} · {r.threadQuote ? `in “${r.threadQuote}”` : 'Main conversation'}</span>
                      <Snippet text={r.snippet} />
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
        <div className="search-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span className="search-foot-hint">Words match in any order; &quot;quotes&quot; match a phrase</span>
        </div>
      </div>
    </div>
  )
}
