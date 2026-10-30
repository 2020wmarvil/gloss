// The Plugins screen (SPEC → Plugins, docs/mocks/plugins.html): the personal plugin library,
// in the center like Worktrees. Its data lives in the plugin library folder, not settings.json.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, BookOpen, Check, ChevronRight, ExternalLink, FolderOpen, Package, Pencil, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react'
import type { PersonalPlugin, PluginAgentState, PluginFile, PluginLibraryState, PluginSkill, SkillInvocation } from '@shared/plugins'
import { Markdown } from './Markdown'
import { errorText } from './errors'
import { clampWidth, ResizeHandle, useStoredWidth } from './resize'

type Tab = 'overview' | 'skills' | 'tools' | 'agents'
type Guard = (leave: () => void) => void
type Dialog =
  | { kind: 'new' }
  | { kind: 'edit' | 'skill' | 'connections' | 'remove'; plugin: PersonalPlugin }
  | { kind: 'file' | 'removeSkill'; plugin: PersonalPlugin; skill: PluginSkill }
  | { kind: 'removeFile'; plugin: PersonalPlugin; skill: PluginSkill; file: PluginFile }
  | { kind: 'custom'; agent: PluginAgentState }
  | { kind: 'discard'; leave: () => void }
type Props = {
  /** Opens Settings → MCP servers. */
  onManageConnections(): void
  onClose(): void
  /** Lets the app ask before leaving with unsaved edits. */
  onNavigationGuard?(guard: Guard | null): void
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
const summary = (p: PersonalPlugin): string => [count(p.skills.length, 'skill'), ...p.connections].join(' · ')
const stateLabel = (a: PluginAgentState): string => ({ ready: 'On', off: 'Off', setup: a.support === 'unknown' ? 'Set up' : 'Needs setup', pending: 'Pending', error: 'Review' })[a.status]

export function PluginsScreen({ onManageConnections, onClose, onNavigationGuard }: Props): React.JSX.Element {
  const [state, setState] = useState<PluginLibraryState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [skillId, setSkillId] = useState<string | null>(null)
  const [file, setFile] = useState<PluginFile | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const activeEditor = useRef<{ file: PluginFile | null; editing: boolean; pluginId?: string }>({ file, editing })
  const workspace = useRef<HTMLDivElement>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [detailWidth, setDetailWidth] = useStoredWidth('gloss.pluginDetailWidth')
  const detailLimits = { min: 290, max: workspaceWidth - 240 }
  useEffect(() => {
    if (!workspace.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width))
    observer.observe(workspace.current)
    return () => observer.disconnect()
  }, [])
  const request = useRef(0)
  const fileRequest = useRef(0)
  const live = useRef(true)
  const plugin = state?.plugins.find(p => p.id === selected) ?? state?.plugins[0]
  activeEditor.current = { file, editing, pluginId: plugin?.id }
  const skill = plugin?.skills.find(s => s.id === skillId)
  const dirty = editing && file !== null && draft !== file.content

  const reload = useCallback(async (): Promise<PluginLibraryState> => {
    const serial = ++request.current
    const next = await window.gloss.plugins.list()
    if (live.current && serial === request.current) setState(next)
    return next
  }, [])
  const refreshPreview = useCallback(async (): Promise<void> => {
    const { file, editing, pluginId } = activeEditor.current
    if (!file || editing || !pluginId) return
    const serial = ++fileRequest.current
    const stillPreviewing = (): boolean => live.current && serial === fileRequest.current
      && !activeEditor.current.editing && activeEditor.current.pluginId === pluginId
      && activeEditor.current.file?.path === file.path
    try {
      const next = await window.gloss.plugins.readFile(pluginId, file.path)
      if (stillPreviewing() && next.revision !== activeEditor.current.file?.revision) {
        setFile(next); setDraft(next.content)
      }
    } catch (err) { if (stillPreviewing()) setError(errorText(err)) }
  }, [])
  useEffect(() => {
    live.current = true
    void reload().catch(e => setError(errorText(e)))
    const dispose = window.gloss.onEvent(event => {
      if (event.type === 'pluginsChanged') void refreshPreview()
      if (event.type === 'pluginsChanged' || event.type === 'settings' || event.type === 'agents') void reload().catch(e => { if (live.current) setError(errorText(e)) })
    })
    return () => { live.current = false; request.current++; fileRequest.current++; dispose() }
  }, [reload, refreshPreview])

  const navigate = useCallback((leave: () => void): void => {
    if (dirty) setDialog({ kind: 'discard', leave })
    else leave()
  }, [dirty])
  useEffect(() => { onNavigationGuard?.(navigate); return () => onNavigationGuard?.(null) }, [navigate, onNavigationGuard])
  // Esc closes the screen, unless a dialog (which handles its own Esc) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) navigate(onClose)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, onClose])

  function resetDetail(): void { fileRequest.current++; setFile(null); setEditing(false); setSkillId(null); setError(null) }
  function select(id: string): void { navigate(() => { setSelected(id); setTab('overview'); resetDetail() }) }
  function isPending(key: string): boolean { return pending.has(key) }
  async function execute(key: string, operation: () => Promise<unknown>, reportError = true, refresh = true): Promise<void> {
    if (pendingRef.current.has(key)) return
    pendingRef.current.add(key); setPending(new Set(pendingRef.current)); setError(null)
    try { await operation(); if (refresh) await reload() }
    catch (err) { if (live.current && reportError) setError(errorText(err)); throw err }
    finally {
      pendingRef.current.delete(key)
      if (live.current) setPending(new Set(pendingRef.current))
    }
  }
  function run(key: string, operation: () => Promise<unknown>, refresh = true): void { void execute(key, operation, true, refresh).catch(() => {}) }
  async function openFile(p: PersonalPlugin, s: PluginSkill, path = s.path): Promise<void> {
    const serial = ++fileRequest.current
    const sameFile = activeEditor.current.file?.path === path
    setSelected(p.id); setTab('skills'); setSkillId(s.id); setEditing(false); if (!sameFile) setFile(null); setError(null)
    try {
      const next = await window.gloss.plugins.readFile(p.id, path)
      if (live.current && serial === fileRequest.current && !(sameFile && activeEditor.current.editing)) { setFile(next); setDraft(next.content) }
    } catch (err) { if (live.current && serial === fileRequest.current) setError(errorText(err)) }
  }
  async function changeInvocation(p: PersonalPlugin, s: PluginSkill, invocation: SkillInvocation): Promise<void> {
    const serial = fileRequest.current
    const path = file?.path
    const stillPreviewing = (): boolean => live.current && serial === fileRequest.current
      && !activeEditor.current.editing && activeEditor.current.file?.path === path
    await execute(`invocation:${p.id}:${s.id}`, async () => {
      await window.gloss.plugins.setSkillInvocation(p.id, s.id, invocation, s.invocationRevision)
      await reload()
      // Refresh the native policy text in place. Navigation and any new edits take precedence.
      if (path && stillPreviewing()) {
        const next = await window.gloss.plugins.readFile(p.id, path)
        if (stillPreviewing()) { setFile(next); setDraft(next.content) }
      }
    }, true, false).catch(() => {})
  }
  async function saveFile(): Promise<void> {
    if (!plugin || !file) return
    const serial = fileRequest.current
    await execute(`file:${plugin.id}:${file.path}`, async () => {
      await window.gloss.plugins.writeFile(plugin.id, { ...file, content: draft })
      const next = await window.gloss.plugins.readFile(plugin.id, file.path)
      if (live.current && serial === fileRequest.current) { setFile(next); setDraft(next.content); setEditing(false) }
    })
  }
  const shown = state?.plugins.filter(p => `${p.name} ${p.description} ${p.skills.map(s => s.name).join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? []

  function components(p: PersonalPlugin): React.JSX.Element {
    return <>
      <div className="plugin-component-group"><h4>Skills</h4>
        {p.skills.length ? p.skills.map(s => <button className="plugin-component" key={s.id} onClick={() => navigate(() => { void openFile(p, s) })}>
          <BookOpen /><span><strong>{s.name}</strong><small>{s.description}</small>{p.connections.length > 0 && <small>Uses {p.connections.join(', ')}</small>}</span><ChevronRight />
        </button>) : <p className="muted">No skills yet.</p>}
      </div>
      {p.connections.length > 0 && <div className="plugin-component-group"><h4>Tools &amp; connections</h4>{p.connections.map(name => {
        const connection = state?.connections.find(c => c.name === name)
        return <button className="plugin-component" key={name} onClick={() => { setTab('tools'); setSkillId(null) }}>
          <Server /><span><strong>{name}</strong><small>{connection ? `${connection.transport.toUpperCase()} · shared MCP connection` : 'Configure this connection in MCP servers.'}</small></span><span className={`plugin-badge ${connection ? '' : 'warn'}`}>{connection ? 'Configured' : 'Missing'}</span>
        </button>
      })}</div>}
    </>
  }
  function tools(p: PersonalPlugin): React.JSX.Element {
    return <><div className="plugin-inline-heading"><h4>Shared connections</h4><button className="ghost sm" disabled={isPending(`connections:${p.id}`)} onClick={() => setDialog({ kind: 'connections', plugin: p })}><Plus />Add connection</button></div>
      {p.connections.length ? p.connections.map(name => {
        const connection = state?.connections.find(c => c.name === name)
        return <div className="plugin-connection" key={name}><div className="plugin-inline-heading"><strong>{name}</strong><span className={`plugin-badge ${connection ? '' : 'warn'}`}>{connection ? 'Configured' : 'Needs setup'}</span></div>
          <p>{connection ? `${connection.transport.toUpperCase()} MCP. Authentication and availability are checked by the agent when it connects.` : 'This connection is missing from the global MCP settings.'}</p>
          {connection && <p>Used by {connection.usedBy.join(', ')}.</p>}
          <button className="ghost sm" disabled={isPending(`connections:${p.id}`)} onClick={() => run(`connections:${p.id}`, () => window.gloss.plugins.update(p.id, { connections: p.connections.filter(n => n !== name) }))}>Remove from plugin</button>
        </div>
      }) : <p className="muted">No tool connections in this plugin.</p>}
      <button className="plugin-link" onClick={() => navigate(onManageConnections)}>Configure MCP servers</button>
    </>
  }
  function agents(p: PersonalPlugin): React.JSX.Element {
    return <>{p.agents.map(agent => <div className="plugin-agent" key={agent.id}>
      <div className="plugin-inline-heading"><strong>{agent.name}</strong><button disabled={isPending(`agent:${agent.id}`) || p.problems.length > 0 && !agent.enabled} className={`plugin-availability ${agent.status}`} aria-label={`${agent.name}: ${agent.enabled ? 'disable' : 'enable'} ${p.name}`} onClick={() => {
        if (agent.support === 'unknown' && !agent.enabled) setDialog({ kind: 'custom', agent })
        else run(`agent:${agent.id}`, () => window.gloss.plugins.enable(p.id, agent.id, !agent.enabled))
      }}>{agent.status === 'ready' && <Check />}{stateLabel(agent)}</button></div>
      {agent.message && <p>{agent.message}</p>}
      <div className="plugin-agent-actions">
        {agent.status === 'error' && <button className="plugin-link" disabled={isPending(`agent:${agent.id}`)} onClick={() => run(`agent:${agent.id}`, () => window.gloss.plugins.refresh(agent.id))}><RefreshCw />Refresh when idle</button>}
        {agent.id.startsWith('custom:') && <button className="plugin-link" onClick={() => setDialog({ kind: 'custom', agent })}>{agent.skillDirectory ? 'Skill directory' : 'Set up skills'}</button>}
      </div>
    </div>)}</>
  }
  function skillContent(p: PersonalPlugin, s: PluginSkill): React.JSX.Element {
    const fileBusy = file !== null && isPending(`file:${p.id}:${file.path}`)
    return <><div className="plugin-breadcrumb"><button onClick={() => navigate(() => { resetDetail(); setTab('skills') })}><ArrowLeft />{p.name}</button><span>/ {s.name}</span></div>
      <div className="plugin-inline-heading"><h3>{s.name}</h3><button className="icon-button" title="Remove skill" aria-label="Remove skill" onClick={() => setDialog({ kind: 'removeSkill', plugin: p, skill: s })}><Trash2 /></button></div>
      <div className="plugin-file-toolbar">
        <select aria-label="Skill file" value={file?.path ?? s.path} onChange={e => { const path = e.target.value; navigate(() => { void openFile(p, s, path) }) }}>
          {[...new Set(['SKILL.md', ...s.files])].map(path => <option key={path} value={`skills/${s.id}/${path}`}>{path}</option>)}
        </select>
        <button className="icon-button" title="New text file" aria-label="New text file" onClick={() => navigate(() => setDialog({ kind: 'file', plugin: p, skill: s }))}><Plus /></button>
        {file && !editing && <><button className="icon-button" title="Edit file" aria-label="Edit file" onClick={() => setEditing(true)}><Pencil /></button><button className="icon-button" title="Open in external editor" aria-label="Open in external editor" disabled={isPending(`editor:${p.id}:${file.path}`)} onClick={() => run(`editor:${p.id}:${file.path}`, () => window.gloss.plugins.openInEditor(p.id, file.path), false)}><ExternalLink /></button></>}
        {file && file.path !== s.path && <button className="icon-button" title="Delete file" aria-label="Delete file" disabled={fileBusy} onClick={() => navigate(() => setDialog({ kind: 'removeFile', plugin: p, skill: s, file }))}><Trash2 /></button>}
      </div>
      {file ? <>
          {editing ? <><label className="sr-only" htmlFor="plugin-file-editor">File contents</label><textarea id="plugin-file-editor" className="plugin-editor" value={draft} disabled={fileBusy} spellCheck={false} onChange={e => setDraft(e.target.value)} /><div className="plugin-editor-actions"><button className="primary" aria-busy={fileBusy} onClick={() => { void saveFile().catch(() => {}) }}>Save</button><button className="ghost" disabled={fileBusy} onClick={() => navigate(() => { setEditing(false); setDraft(file.content) })}>Cancel</button></div></>
            : file.path.endsWith('.md') ? <Markdown text={file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*\n?/, '')} listItemReplies={false} /> : <pre className="plugin-file-content">{file.content}</pre>}
        </> : !error && <p className="muted">Loading file…</p>}
      <InvocationChoice footer value={s.invocation} disabled={fileBusy || isPending(`invocation:${p.id}:${s.id}`)} onChange={invocation => navigate(() => { void changeInvocation(p, s, invocation) })} />
    </>
  }
  return <main className="plugins-screen"><section className="plugin-settings" aria-label="Plugins">
    <header className="plugin-library-header"><div><h2>Plugins</h2><p>Your skills and tools, kept together. To import a plugin or skill, ask any session to use the <code>gloss-plugins</code> skill.</p></div></header>
    {!dialog && error && <p className="plugin-error" role="alert">{error}</p>}{!dialog && state?.errors.map(e => <p className="plugin-error" role="alert" key={e}>{e}</p>)}
    <div className="plugin-workspace" ref={workspace}><div className="plugin-library">
      <div className="plugin-toolbar"><label className="plugin-search"><Search /><input aria-label="Find a plugin" placeholder="Find a plugin…" value={query} onChange={e => setQuery(e.target.value)} /></label><button className="primary" disabled={!state} onClick={() => navigate(() => setDialog({ kind: 'new' }))}><Plus />New plugin</button></div>
      <div className="plugin-list">{shown.map(p => <button key={p.id} className={`plugin-list-item ${p.id === plugin?.id ? 'selected' : ''}`} aria-pressed={p.id === plugin?.id} onClick={() => select(p.id)}><span className="plugin-package-mark"><Package /></span><span><strong>{p.name}</strong><span>{p.description}</span><small>{p.problems.length ? 'Needs attention' : summary(p)}</small></span></button>)}
        {!state && !error && <p className="plugin-empty">Loading plugins…</p>}
        {state && !shown.length && <div className="plugin-empty"><Package /><h3>{state.plugins.length ? 'No matching plugins' : 'Start with a plugin of your own'}</h3>{state.plugins.length > 0 && <button className="secondary" onClick={() => setQuery('')}>Clear search</button>}</div>}
      </div>
      <button className="plugin-library-folder plugin-link" disabled={isPending('folder:library')} onClick={() => run('folder:library', () => window.gloss.plugins.openFolder(), false)}><FolderOpen />Open library folder</button>
    </div>
    <ResizeHandle label="Resize plugin details" pane="after" limits={detailLimits} value={detailWidth === null ? null : clampWidth(detailWidth, detailLimits)} onResize={setDetailWidth} onReset={() => setDetailWidth(null)} />
    <aside className="plugin-detail" style={detailWidth === null ? undefined : { '--plugin-detail-width': `${clampWidth(detailWidth, detailLimits)}px` } as React.CSSProperties} aria-label="Plugin details">{plugin ? <>
      <header><div className="plugin-inline-heading"><h3>{plugin.name}</h3><button className="icon-button" aria-label="Open plugin folder" title="Open plugin folder" disabled={isPending(`folder:${plugin.id}`)} onClick={() => run(`folder:${plugin.id}`, () => window.gloss.plugins.openFolder(plugin.id), false)}><FolderOpen /></button><button className="icon-button" aria-label="Edit plugin details" title="Edit plugin details" onClick={() => navigate(() => setDialog({ kind: 'edit', plugin }))}><Pencil /></button><button className="icon-button" aria-label="Remove plugin" title="Remove plugin" onClick={() => navigate(() => setDialog({ kind: 'remove', plugin }))}><Trash2 /></button></div><p>{plugin.description}</p></header>
      <nav className="plugin-tabs" aria-label="Plugin sections">{(['overview', 'skills', 'tools', 'agents'] as Tab[]).map(t => <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => navigate(() => { resetDetail(); setTab(t) })}>{t[0].toUpperCase() + t.slice(1)}</button>)}</nav>
      <div className="plugin-detail-content">{!dialog && plugin.problems.map(problem => <p className="plugin-error" role="alert" key={problem}>{problem}</p>)}{skill ? skillContent(plugin, skill) : tab === 'overview' ? components(plugin) : tab === 'skills' ? <><div className="plugin-inline-heading"><h4>Skills in this plugin</h4><button className="ghost sm" onClick={() => setDialog({ kind: 'skill', plugin })}><Plus />Add skill</button></div>{components({ ...plugin, connections: [] })}</> : tab === 'tools' ? tools(plugin) : agents(plugin)}</div>
    </> : <div className="plugin-empty"><Package /><h3>One place for each workflow</h3></div>}</aside></div>
    {dialog && <PluginDialog key={dialog.kind + ('plugin' in dialog ? dialog.plugin.id : '')} dialog={dialog} state={state} busy={isPending('dialog')} onClose={() => setDialog(null)} onManageConnections={onManageConnections} onSubmit={async values => {
      if (pendingRef.current.has('dialog')) return
      if (dialog.kind === 'discard') { setEditing(false); setDraft(file?.content ?? ''); setDialog(null); dialog.leave(); return }
      await execute('dialog', async () => {
        if (dialog.kind === 'new') {
          const id = await window.gloss.plugins.create(values.name, values.description)
          const next = await reload(); const p = next.plugins.find(p => p.id === id)!
          setSelected(id); await openFile(p, p.skills[0]); setEditing(true)
        } else if (dialog.kind === 'edit') await window.gloss.plugins.update(dialog.plugin.id, { name: values.name, description: values.description })
        else if (dialog.kind === 'skill') {
          const id = await window.gloss.plugins.addSkill(dialog.plugin.id, values.name, values.description, values.invocation as SkillInvocation)
          const next = await reload(); const p = next.plugins.find(p => p.id === dialog.plugin.id)!
          await openFile(p, p.skills.find(s => s.id === id)!)
        } else if (dialog.kind === 'file') {
          await window.gloss.plugins.createFile(dialog.plugin.id, dialog.skill.id, values.path, values.content)
          await openFile(dialog.plugin, dialog.skill, `skills/${dialog.skill.id}/${values.path}`)
        } else if (dialog.kind === 'connections') await window.gloss.plugins.update(dialog.plugin.id, { connections: JSON.parse(values.connections) })
        else if (dialog.kind === 'custom') await window.gloss.plugins.setSkillDirectory(dialog.agent.id, values.directory)
        else if (dialog.kind === 'remove') { await window.gloss.plugins.remove(dialog.plugin.id); setSelected(null); resetDetail() }
        else if (dialog.kind === 'removeFile') { await window.gloss.plugins.removeFile(dialog.plugin.id, dialog.file); await openFile(dialog.plugin, dialog.skill) }
        else if (dialog.kind === 'removeSkill') { await window.gloss.plugins.removeSkill(dialog.plugin.id, dialog.skill.id); resetDetail(); setTab('skills') }
      }, false)
      setDialog(null)
    }} />}
  </section></main>
}

function InvocationChoice({ value, disabled, onChange, footer = false }: { value: SkillInvocation | 'mixed'; disabled: boolean; onChange(mode: SkillInvocation): void; footer?: boolean }): React.JSX.Element {
  return <fieldset className={`plugin-invocation-choice${footer ? ' plugin-invocation-footer' : ''}`} aria-label="Skill invocation" disabled={disabled}>
    <legend className={footer ? 'sr-only' : undefined}>Invocation</legend>
    {value === 'mixed' && <small className="muted">Mixed settings</small>}
    <div>{(['automatic', 'direct'] as const).map(mode => <label key={mode} title={mode === 'automatic' ? 'The agent can choose this skill when it is relevant. You can also invoke it directly.' : 'Use this skill only when you explicitly invoke it. Supported by Claude Code, Codex and OpenCode 2; custom agents are unverified.'}>
      <input type="radio" name={footer ? 'skill-invocation' : 'invocation'} value={mode} checked={value === mode} onChange={() => onChange(mode)} />
      <span>{mode === 'automatic' ? 'Automatic' : 'Direct only'}</span>
    </label>)}</div>
  </fieldset>
}

function PluginDialog({ dialog, state, busy, onClose, onSubmit, onManageConnections }: { dialog: Dialog; state: PluginLibraryState | null; busy: boolean; onClose(): void; onSubmit(values: Record<string, string>): Promise<void>; onManageConnections(): void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState<Record<string, string>>({ name: dialog.kind === 'edit' ? dialog.plugin.name : '', description: dialog.kind === 'edit' ? dialog.plugin.description : '', path: '', content: '', invocation: 'automatic', directory: dialog.kind === 'custom' ? dialog.agent.skillDirectory ?? '' : '', connections: JSON.stringify(dialog.kind === 'connections' ? dialog.plugin.connections : []) })
  const [error, setError] = useState<string | null>(null)
  const [confirmedFormat, setConfirmedFormat] = useState(dialog.kind === 'custom' && !!dialog.agent.skillDirectory)
  const close = useRef(onClose); close.current = onClose
  const submitting = useRef(busy); submitting.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ;(ref.current?.querySelector('input, textarea') as HTMLElement | null ?? ref.current?.querySelector('button'))?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!submitting.current) close.current() }
      if (e.key === 'Tab') {
        const fields = [...ref.current!.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)')]
        const first = fields[0], last = fields.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus() }
  }, [])
  const field = (name: string, label: string, multiline = false, placeholder?: string): React.JSX.Element => <label className="plugin-form-field" key={name}><span title={dialog.kind === 'new' || dialog.kind === 'skill' ? name === 'name' ? `A short name for your ${dialog.kind === 'skill' ? 'skill' : 'plugin'}.` : dialog.kind === 'skill' ? 'Describe when the agent should use this skill.' : 'Describe what this plugin helps you do.' : undefined}>{label}</span>{multiline ? <textarea disabled={busy} placeholder={placeholder} value={values[name]} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} /> : <input disabled={busy} placeholder={placeholder} value={values[name]} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} />}</label>
  const title = { new: 'New plugin', edit: 'Edit plugin', skill: 'Add skill', file: 'New text file', connections: 'Plugin connections', custom: 'Custom agent skills', remove: 'Remove plugin?', removeSkill: 'Remove skill?', removeFile: 'Delete file?', discard: 'Discard unsaved changes?' }[dialog.kind]
  const creating = dialog.kind === 'new' || dialog.kind === 'skill'
  const needsName = ['new', 'edit', 'skill'].includes(dialog.kind)
  const disabled = busy || needsName && !values.name.trim() || dialog.kind === 'skill' && !values.description.trim() || dialog.kind === 'file' && !values.path.trim() || dialog.kind === 'custom' && (!confirmedFormat || !values.directory.trim())
  const action = { new: 'Create plugin', edit: 'Save details', skill: 'Add skill', file: 'Create file', connections: 'Save connections', custom: 'Save directory', remove: 'Remove plugin', removeSkill: 'Remove skill', removeFile: 'Delete file', discard: 'Discard changes' }[dialog.kind]
  return createPortal(<div className="dialog-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}><div className={`dialog plugin-dialog${creating ? ' plugin-create-dialog' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title">
    <div className="plugin-inline-heading">{creating ? <div className="plugin-create-heading"><span className="plugin-create-mark" aria-hidden="true">{dialog.kind === 'skill' ? <BookOpen /> : <Package />}</span><h2 id="plugin-dialog-title">{title}</h2></div> : <h2 id="plugin-dialog-title">{title}</h2>}<button className="icon-button" disabled={busy} aria-label="Close dialog" onClick={onClose}><X /></button></div>
    <form onSubmit={e => { e.preventDefault(); if (!disabled) { setError(null); void onSubmit(values).catch(err => setError(errorText(err))) } }}>
      {needsName && <>{field('name', creating ? 'Name' : 'Plugin name', false, dialog.kind === 'skill' ? 'e.g. Summarize' : dialog.kind === 'new' ? 'e.g. Standup' : undefined)}{field('description', creating ? 'Description' : 'When should this be used?', true, dialog.kind === 'skill' ? 'e.g. Summarize supplied text into three short bullets.' : dialog.kind === 'new' ? 'e.g. Turn recent work into a short daily update.' : undefined)}</>}
      {dialog.kind === 'skill' && <InvocationChoice value={values.invocation as SkillInvocation} disabled={busy} onChange={invocation => setValues(v => ({ ...v, invocation }))} />}
      {dialog.kind === 'file' && <>{field('path', 'Path within the skill, such as references/checklist.md')}{field('content', 'Contents', true)}</>}
      {dialog.kind === 'connections' && <>{state?.connections.length ? state.connections.map(c => <label className="plugin-connection-choice" key={c.name}><input type="checkbox" disabled={busy} checked={(JSON.parse(values.connections) as string[]).includes(c.name)} onChange={e => { const current: string[] = JSON.parse(values.connections); setValues(v => ({ ...v, connections: JSON.stringify(e.target.checked ? [...current, c.name] : current.filter(n => n !== c.name)) })) }} /><span><strong>{c.name}</strong><small>{c.transport.toUpperCase()}{c.usedBy.length ? ` · used by ${c.usedBy.join(', ')}` : ''}</small></span></label>) : <p>No MCP connections have been configured yet.</p>}<p>These are shared global connections. Removing a reference from this plugin preserves their other uses. Authentication is handled by the agent.</p><button type="button" className="plugin-link" disabled={busy} onClick={onManageConnections}>Configure MCP servers</button></>}
      {dialog.kind === 'custom' && <><p>{dialog.agent.name} needs its own skill directory. This configures skill delivery only; it does not establish native plugin or remote MCP support.</p>{field('directory', 'Absolute skill-directory path')}<label className="plugin-connection-choice"><input type="checkbox" disabled={busy} checked={confirmedFormat} onChange={e => setConfirmedFormat(e.target.checked)} />This agent supports SKILL.md skill folders.</label><p>Gloss creates only its own namespaced links here. Existing files are preserved. Turn off this agent’s plugins before changing the directory.</p></>}
      {dialog.kind === 'remove' && <p>Remove <strong>{dialog.plugin.name}</strong>, its files, and its Gloss-managed deployments?</p>}
      {dialog.kind === 'removeSkill' && <p>Remove <strong>{dialog.skill.name}</strong> and its supporting files?</p>}
      {dialog.kind === 'removeFile' && <p>Delete <strong>{dialog.file.path.split('/').slice(2).join('/')}</strong>?</p>}
      {dialog.kind === 'discard' && <p>The editor has unsaved changes. The saved file will be kept.</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button><button className={['remove', 'removeSkill', 'removeFile', 'discard'].includes(dialog.kind) ? 'danger' : 'primary'} disabled={disabled}>{busy ? 'Saving…' : action}</button></div>
    </form>
  </div></div>, document.body)
}
