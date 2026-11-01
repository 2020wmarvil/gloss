import { useEffect, useRef, useState } from 'react'
import { Archive, GitFork, Lock, Search } from 'lucide-react'
import type { Project } from '@shared/types'
import { parseGithubRepo, type GithubRepo } from '@shared/github'
import { errorText } from './errors'
import { ago } from './Sidebar'

/** The rows the list shows for a query: a pasted repository first when it isn't one of the user's, then the matches. */
export function cloneChoices(repos: GithubRepo[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const matches = repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)).map((r) => r.fullName)
  const pasted = parseGithubRepo(query)
  const known = pasted && repos.find((r) => r.fullName.toLowerCase() === pasted.toLowerCase())?.fullName
  if (known) return [known, ...matches.filter((m) => m !== known)]
  return pasted ? [pasted, ...matches] : matches
}

/** Repositories grouped by owner, owners in the order they first appear (so by their latest push). */
export function byOwner(names: string[]): { owner: string; names: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const owner = name.slice(0, name.indexOf('/'))
    const key = owner.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), name])
  }
  return [...groups.values()].map((names) => ({ owner: names[0].slice(0, names[0].indexOf('/')), names }))
}

/**
 * Open a project from GitHub (SPEC → Projects and sessions): the user's repositories through
 * `gh`, filtered as they type, or a pasted name or URL. Choosing one asks where to clone it.
 */
export function CloneDialog({ onClose, onOpened }: { onClose(): void; onOpened(project: Project): void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [cloning, setCloning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    input.current?.focus()
    let live = true
    window.gloss.projects.githubRepos().then(
      (r) => live && setRepos(r),
      (err: unknown) => {
        if (!live) return
        setRepos([])
        setError(errorText(err))
      }
    )
    return () => {
      live = false
    }
  }, [])

  const byName = new Map((repos ?? []).map((r) => [r.fullName, r]))
  const groups = byOwner(cloneChoices(repos ?? [], query))
  // The arrows move through the rows as shown: owner by owner.
  const choices = groups.flatMap((g) => g.names)
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  async function clone(name: string): Promise<void> {
    if (cloning) return
    setCloning(name)
    setError(null)
    try {
      const project = await window.gloss.projects.clone(name)
      if (project) onOpened(project)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setCloning(null)
      input.current?.focus()
    }
  }

  return (
    <div className="dialog-backdrop search-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !cloning) onClose() }}>
      <div className="dialog search-dialog clone-dialog" role="dialog" aria-modal="true" aria-labelledby="clone-title" ref={ref}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); if (!cloning) onClose() }
          if (e.key === 'Tab') {
            const controls = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input')]
            const first = controls[0], last = controls.at(-1)
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
          }
        }}>
        <h2 id="clone-title" className="sr-only">Open from GitHub</h2>
        <div className="search-head">
          <label className="search-field">
            <Search aria-hidden />
            <input ref={input} aria-label="Repository" placeholder="Search your repositories, or paste a GitHub URL or owner/name" value={query} disabled={cloning !== null}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (choices.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
                }
                if (e.key === 'Enter' && choices[active]) void clone(choices[active])
              }} />
          </label>
        </div>
        {error && <p role="alert" className="dialog-error clone-error">{error}</p>}
        <div className="search-results" ref={list} aria-busy={repos === null || cloning !== null}>
          {/* Alone in the list, the status sits in its middle; under a pasted repository's row, below it. */}
          {cloning && <p className="search-empty search-center" role="status"><span className="spinner" aria-hidden />Cloning {cloning}…</p>}
          {!cloning && repos === null && (
            <p className={choices.length ? 'search-empty' : 'search-empty search-center'} role="status">
              {!choices.length && <span className="spinner" aria-hidden />}
              Loading your repositories…
            </p>
          )}
          {!cloning && repos !== null && choices.length === 0 && !error && <p className="search-empty">{query.trim() ? 'No matching repositories.' : 'No repositories.'}</p>}
          {!cloning && groups.map((g) => (
            <section key={g.owner} className="search-group" aria-label={g.owner}>
              <div className="search-group-head">
                <span className="clone-owner" aria-hidden>{(/[a-z]/i.exec(g.owner)?.[0] ?? g.owner[0]).toUpperCase()}</span>
                <b>{g.owner}</b>
                <span>{g.names.length} {g.names.length === 1 ? 'repository' : 'repositories'}</span>
              </div>
              {g.names.map((name) => {
                const i = choices.indexOf(name)
                const r = byName.get(name)
                return (
                  <button key={name} className={i === active ? 'search-result clone-repo active' : 'search-result clone-repo'} title={name} onMouseMove={() => setActive(i)} onClick={() => void clone(name)}>
                    <span className="search-body">
                      <span className="clone-name">
                        {name.slice(g.owner.length + 1)}
                        {r?.private && <Lock aria-label="Private" />}
                        {r?.fork && <GitFork aria-label="Fork" />}
                        {r?.archived && <Archive aria-label="Archived" />}
                      </span>
                      {r ? r.description && <span className="search-where">{r.description}</span> : <span className="search-where">Clone this repository</span>}
                    </span>
                    {r && r.pushedAt > 0 && <span className="clone-age" title={new Date(r.pushedAt).toLocaleString()}>{ago(r.pushedAt)}</span>}
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
