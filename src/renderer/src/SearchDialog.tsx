import { useEffect, useRef, useState } from 'react'
import type { SearchRequest, SearchResponse, SearchResult } from '@shared/search'
import { errorText } from './errors'

type Props = {
  sessionId: string | null
  cwd: string | null
  onClose(): void
  onOpen(result: SearchResult): Promise<void>
}

export function SearchDialog({ sessionId, cwd, onClose, onOpen }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchRequest['scope']>('all')
  const [kind, setKind] = useState<SearchRequest['kind']>('all')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setResponse(null)
    setError(null)
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

  async function choose(result: SearchResult): Promise<void> {
    setOpening(true)
    setError(null)
    try { await onOpen(result); onClose() }
    catch (err) { setError(`Couldn't open result: ${errorText(err)}`) }
    finally { setOpening(false) }
  }

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
        <div className="search-heading"><h2 id="search-title">Search conversations</h2><button onClick={onClose} disabled={opening}>Close</button></div>
        <input ref={input} aria-label="Search conversations" placeholder='Search words or "an exact phrase"' value={query} maxLength={1000}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && response?.results[0] && !loading && !opening) void choose(response.results[0]) }} />
        <div className="search-filters">
          <label>Search in <select value={scope} onChange={(e) => setScope(e.target.value as SearchRequest['scope'])}>
            <option value="all">Everything</option><option value="project" disabled={!cwd}>Current project</option><option value="session" disabled={!sessionId}>Current session</option>
          </select></label>
          <label>Show <select value={kind} onChange={(e) => setKind(e.target.value as SearchRequest['kind'])}>
            <option value="all">All messages and tools</option><option value="user">Your messages</option><option value="agent">Agent messages</option><option value="tool">Tool output</option>
          </select></label>
        </div>
        <p className="muted">Searches history loaded into Gloss. Open other agent sessions to include them.</p>
        <div role="status" aria-live="polite">
          {loading ? 'Searching...' : response ? `${response.results.length}${response.more ? '+' : ''} results${response.more ? '. Showing the first 100. Refine your search for more.' : ''}` : 'Enter words to search your conversations.'}
        </div>
        {error && <p role="alert" className="dialog-error">{error}</p>}
        <div className="search-results" aria-busy={loading || opening}>
          {response?.results.map((r) => <button className="search-result" key={`${r.sessionId}:${r.kind}:${r.id}`} disabled={opening} onClick={() => void choose(r)}>
            <strong>{r.sessionTitle}</strong>
            <span className="muted">{r.cwd} / {r.kind === 'user' ? 'You' : r.kind === 'agent' ? 'Agent' : 'Tool'} / {r.threadQuote ? `Thread: ${r.threadQuote}` : 'Main conversation'}</span>
            <span className="search-snippet">{r.snippet.split('\u0001').map((part, i) => {
              const end = part.indexOf('\u0002')
              return i > 0 && end >= 0 ? <span key={i}><mark>{part.slice(0, end)}</mark>{part.slice(end + 1)}</span> : part
            })}</span>
          </button>)}
        </div>
      </div>
    </div>
  )
}
