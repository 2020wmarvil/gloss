// The Plugins screen (SPEC → Plugins, docs/mocks/plugins.html): a view of the personal plugin
// library, in the center like Worktrees. Its data lives in the plugin library folder, not
// settings.json, and is changed there (by hand or by an agent), never from this screen.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, BookOpen, Bot, Check, ChevronRight, ExternalLink, FolderOpen, Package, RefreshCw, Search, Server, Webhook, X } from 'lucide-react'
import type { PersonalPlugin, PluginAgentState, PluginFile, PluginHook, PluginLibraryState, PluginSkill, PluginSubagent } from '@shared/plugins'
import { Markdown } from './Markdown'
import { errorText } from './errors'
import { clampWidth, ResizeHandle, useStoredWidth } from './resize'

type Tab = 'overview' | 'skills' | 'subagents' | 'hooks' | 'tools' | 'agents'
type Dialog =
  | { kind: 'custom'; agent: PluginAgentState }
  | { kind: 'hooks'; plugin: PersonalPlugin; agent: PluginAgentState }
type Props = {
  /** Opens Settings → MCP servers. */
  onManageConnections(): void
  onClose(): void
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
/** What a plugin holds, leaving out what it has none of. */
const summary = (p: PersonalPlugin): string => [...(p.skills.length ? [count(p.skills.length, 'skill')] : []), ...(p.subagents.length ? [count(p.subagents.length, 'subagent')] : []), ...(p.hooks.length ? [count(p.hooks.length, 'hook')] : []), ...p.connections].join(' · ') || 'Empty'
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', skills: 'Skills', subagents: 'Subagents', hooks: 'Hooks', tools: 'MCP', agents: 'Agents' }
const EVENTS: Record<string, string> = { sessionStart: 'Session starts', userPrompt: 'Prompt is sent', beforeTool: 'Before a tool runs', afterTool: 'After a tool runs', stop: 'Turn ends' }
const TOOLS: Record<string, string> = { shell: 'Shell commands', edit: 'File edits', read: 'File reads', any: 'Every tool' }
const toolLabel = (h: PluginHook): string | undefined => h.matcher === undefined ? (h.event === 'beforeTool' || h.event === 'afterTool' ? 'Every tool' : undefined)
  : TOOLS[h.matcher] ?? (h.matcher.startsWith('mcp:') ? `${h.matcher.slice(4)} tools` : h.matcher)
/** The hooks an agent would run if the plugin were on for it. Custom agents get skills only. */
const hooksFor = (p: PersonalPlugin, agentId: string): PluginHook[] => agentId.startsWith('custom:') ? [] : p.hooks.filter(h => !h.agents || h.agents.includes(agentId))
const stateLabel = (a: PluginAgentState): string => ({ ready: 'On', off: 'Off', setup: a.support === 'unknown' ? 'Set up' : 'Needs setup', pending: 'Pending', error: 'Review' })[a.status]

export function PluginsScreen({ onManageConnections, onClose }: Props): React.JSX.Element {
  const [state, setState] = useState<PluginLibraryState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [skillId, setSkillId] = useState<string | null>(null)
  const [subagentId, setSubagentId] = useState<string | null>(null)
  const [file, setFile] = useState<PluginFile | null>(null)
  const openFileRef = useRef<{ file: PluginFile | null; pluginId?: string }>({ file })
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
  const plugin = state?.plugins.find(p => p.id === selected) ?? state?.plugins.find(p => !p.builtin) ?? state?.plugins[0]
  openFileRef.current = { file, pluginId: plugin?.id }
  const skill = plugin?.skills.find(s => s.id === skillId)
  const subagent = plugin?.subagents.find(s => s.id === subagentId)

  const reload = useCallback(async (): Promise<PluginLibraryState> => {
    const serial = ++request.current
    const next = await window.gloss.plugins.list()
    if (live.current && serial === request.current) setState(next)
    return next
  }, [])
  /** Re-reads the open file after a change in the library folder. */
  const refreshFile = useCallback(async (): Promise<void> => {
    const { file, pluginId } = openFileRef.current
    if (!file || !pluginId) return
    const serial = ++fileRequest.current
    const current = (): boolean => live.current && serial === fileRequest.current && openFileRef.current.pluginId === pluginId && openFileRef.current.file?.path === file.path
    try {
      const next = await window.gloss.plugins.readFile(pluginId, file.path)
      if (current() && next.revision !== openFileRef.current.file?.revision) setFile(next)
    } catch (err) { if (current()) setError(errorText(err)) }
  }, [])
  useEffect(() => {
    live.current = true
    void reload().catch(e => setError(errorText(e)))
    const dispose = window.gloss.onEvent(event => {
      if (event.type === 'pluginsChanged') void refreshFile()
      if (event.type === 'pluginsChanged' || event.type === 'settings' || event.type === 'agents') void reload().catch(e => { if (live.current) setError(errorText(e)) })
    })
    return () => { live.current = false; request.current++; fileRequest.current++; dispose() }
  }, [reload, refreshFile])
  // Esc closes the screen, unless a dialog (which handles its own Esc) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function resetDetail(): void { fileRequest.current++; setFile(null); setSkillId(null); setSubagentId(null); setError(null) }
  function select(id: string): void { setSelected(id); setTab('overview'); resetDetail() }
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
  /** Opens a skill's file (`id` the skill) or a subagent's (`id` the subagent). */
  async function openFile(p: PersonalPlugin, path: string, nextTab: 'skills' | 'subagents', id: string): Promise<void> {
    const serial = ++fileRequest.current
    const sameFile = openFileRef.current.file?.path === path
    setSelected(p.id); setTab(nextTab); setSkillId(nextTab === 'skills' ? id : null); setSubagentId(nextTab === 'subagents' ? id : null); if (!sameFile) setFile(null); setError(null)
    try {
      const next = await window.gloss.plugins.readFile(p.id, path)
      if (live.current && serial === fileRequest.current) setFile(next)
    } catch (err) { if (live.current && serial === fileRequest.current) setError(errorText(err)) }
  }
  const shown = state?.plugins.filter(p => `${p.name} ${p.description} ${p.skills.map(s => s.name).join(' ')}`.toLowerCase().includes(query.toLowerCase())) ?? []

  function skillList(p: PersonalPlugin): React.JSX.Element | null {
    return p.skills.length ? <>{p.skills.map(s => <button className="plugin-component" key={s.id} onClick={() => { void openFile(p, s.path, 'skills', s.id) }}>
      <BookOpen /><span><strong>{s.name}</strong><small>{s.description}</small>{p.connections.length > 0 && <small>Uses {p.connections.join(', ')}</small>}</span><ChevronRight />
    </button>)}</> : null
  }
  function subagentList(p: PersonalPlugin): React.JSX.Element | null {
    return p.subagents.length ? <>{p.subagents.map(s => <button className="plugin-component" key={s.id} onClick={() => { void openFile(p, s.path, 'subagents', s.id) }}>
      <Bot /><span><strong>{s.id}</strong><small>{s.description}</small></span><ChevronRight />
    </button>)}</> : null
  }
  function connectionList(p: PersonalPlugin): React.JSX.Element | null {
    return p.connections.length ? <>{p.connections.map(name => {
      const connection = state?.connections.find(c => c.name === name)
      return <button className="plugin-component" key={name} onClick={() => { resetDetail(); setTab('tools') }}>
        <Server /><span><strong>{name}</strong><small>{connection ? `${connection.transport.toUpperCase()} · from Settings → MCP servers` : 'Add this server in Settings → MCP servers.'}</small></span><span className={`plugin-badge ${connection ? '' : 'warn'}`}>{connection ? 'Configured' : 'Missing'}</span>
      </button>
    })}</> : null
  }
  function overview(p: PersonalPlugin): React.JSX.Element {
    return <>
      <div className="plugin-component-group"><h4>Skills</h4>{skillList(p)}</div>
      <div className="plugin-component-group"><h4>Subagents</h4>{subagentList(p)}</div>
      <div className="plugin-component-group"><h4>Hooks</h4>{p.hooks.length ? <button className="plugin-component" onClick={() => { resetDetail(); setTab('hooks') }}>
        <Webhook /><span><strong>{count(p.hooks.length, 'hook')}</strong><small>{[...new Set(p.hooks.map(h => EVENTS[h.event] ?? h.event))].join(' · ')}</small></span><ChevronRight />
      </button> : null}</div>
      <div className="plugin-component-group"><h4>MCP servers</h4>{connectionList(p)}</div>
    </>
  }
  function tools(p: PersonalPlugin): React.JSX.Element {
    return <><h4>MCP servers in this plugin</h4>
      {p.connections.length ? p.connections.map(name => {
        const connection = state?.connections.find(c => c.name === name)
        return <div className="plugin-connection" key={name}><div className="plugin-inline-heading"><strong>{name}</strong><span className={`plugin-badge ${connection ? '' : 'warn'}`}>{connection ? 'Configured' : 'Needs setup'}</span></div>
          <p>{connection ? `${connection.transport.toUpperCase()}. Authentication and availability are checked by the agent when it connects.` : 'This server is missing from Settings → MCP servers.'}</p>
          {connection && <p>Used by {connection.usedBy.join(', ')}.</p>}
        </div>
      }) : null}
      <button className="plugin-link" onClick={onManageConnections}>Configure MCP servers</button>
    </>
  }
  function agents(p: PersonalPlugin): React.JSX.Element {
    return <>{p.agents.map(agent => <div className="plugin-agent" key={agent.id}>
      <div className="plugin-inline-heading"><strong>{agent.name}</strong>{p.builtin ? <span className={`plugin-availability ${agent.status}`}>{agent.status === 'ready' && <Check />}{agent.status === 'ready' ? 'Always on' : stateLabel(agent)}</span> : <button disabled={isPending(`agent:${agent.id}`) || p.problems.length > 0 && !agent.enabled} className={`plugin-availability ${agent.status}`} aria-label={`${agent.name}: ${agent.enabled ? 'disable' : 'enable'} ${p.name}`} onClick={() => {
        if (agent.support === 'unknown' && !agent.enabled) setDialog({ kind: 'custom', agent })
        // Hooks run commands without asking: show them before they're turned on.
        else if (!agent.enabled && hooksFor(p, agent.id).length) setDialog({ kind: 'hooks', plugin: p, agent })
        else run(`agent:${agent.id}`, () => window.gloss.plugins.enable(p.id, agent.id, !agent.enabled))
      }}>{agent.status === 'ready' && <Check />}{stateLabel(agent)}</button>}</div>
      {agent.message && <p>{agent.message}</p>}
      <div className="plugin-agent-actions">
        {agent.status === 'error' && !p.builtin && <button className="plugin-link" disabled={isPending(`agent:${agent.id}`)} onClick={() => run(`agent:${agent.id}`, () => window.gloss.plugins.refresh(agent.id))}><RefreshCw />Refresh when idle</button>}
        {agent.id.startsWith('custom:') && <button className="plugin-link" onClick={() => setDialog({ kind: 'custom', agent })}>{agent.skillDirectory ? 'Skill directory' : 'Set up skills'}</button>}
      </div>
    </div>)}</>
  }
  /** Opens a plugin file in the external editor. */
  function editorButton(p: PersonalPlugin, path: string): React.JSX.Element | false {
    return !p.builtin && <button className="icon-button" title="Open in external editor" aria-label="Open in external editor" disabled={isPending(`editor:${p.id}:${path}`)} onClick={() => run(`editor:${p.id}:${path}`, () => window.gloss.plugins.openInEditor(p.id, path), false)}><ExternalLink /></button>
  }
  /** The open file's rendered contents. */
  function fileView(): React.JSX.Element | false {
    return file ? (file.path.endsWith('.md') ? <Markdown text={file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*\n?/, '')} /> : <pre className="plugin-file-content">{file.content}</pre>)
      : !error && <p className="muted">Loading file…</p>
  }
  function breadcrumb(p: PersonalPlugin, name: string, back: Tab): React.JSX.Element {
    return <div className="plugin-breadcrumb"><button onClick={() => { resetDetail(); setTab(back) }}><ArrowLeft />{p.name}</button><span>/ {name}</span></div>
  }
  /** A skill's or subagent's page: name, description, its settings, then the open file. */
  function partPage(p: PersonalPlugin, name: string, back: Tab, description: string, editorPath: string, settings: [string, React.ReactNode][], section: string): React.JSX.Element {
    return <>{breadcrumb(p, name, back)}
      <div className="plugin-part-title"><h3>{name}</h3>{editorButton(p, editorPath)}</div>
      <p className="plugin-part-description">{description}</p>
      <dl className="plugin-part-settings">{settings.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <h4 className="plugin-part-section">{section}</h4>
      <div className="plugin-part-body">{fileView()}</div>
    </>
  }
  function skillContent(p: PersonalPlugin, s: PluginSkill): React.JSX.Element {
    const path = file?.path ?? s.path
    const files = [...new Set(['SKILL.md', ...s.files])]
    const settings: [string, React.ReactNode][] = [['Invocation', s.invocation === 'automatic'
      ? <>Automatic<small>An agent may use it when it’s relevant, or you can invoke it.</small></>
      : s.invocation === 'direct' ? <>Direct only<small>Used only when you invoke it.</small></>
      : <>Mixed<small>Its agents’ invocation settings disagree.</small></>]]
    if (files.length > 1) settings.push(['File', <select key="file" aria-label="Skill file" value={path} onChange={e => { void openFile(p, e.target.value, 'skills', s.id) }}>
      {files.map(f => <option key={f} value={`skills/${s.id}/${f}`}>{f}</option>)}
    </select>])
    return partPage(p, s.name, 'skills', s.description, path, settings, path === s.path ? 'Instructions' : path.split('/').slice(2).join('/'))
  }
  function subagentContent(p: PersonalPlugin, s: PluginSubagent): React.JSX.Element {
    const agentName = (id: string): string => p.agents.find(a => a.id === id)?.name ?? id
    const models = Object.entries(s.models)
    const settings: [string, React.ReactNode][] = [
      ['Tools', s.tools === 'read-only' ? <>Read-only<small>It can’t edit files or run shell commands.</small></> : <>Same as the session<small>It may do whatever the session that calls it may do.</small></>],
      ['Model', models.length ? <>{models.map(([agent, model]) => `${model} in ${agentName(agent)}`).join(', ')}<small>The session’s model in other agents.</small></> : 'The session’s model']
    ]
    return partPage(p, s.id, 'subagents', s.description, s.path, settings, 'Instructions')
  }
  function hookList(p: PersonalPlugin): React.JSX.Element {
    return <>{p.hooks.map((h, i) => <div className="plugin-hook" key={i}>
      <div className="plugin-inline-heading"><strong>{EVENTS[h.event] ?? h.event}</strong>{toolLabel(h) && <span className="plugin-badge">{toolLabel(h)}</span>}</div>
      <code className="plugin-hook-command">{h.command}</code>
      <small>{h.agents ? `Only ${h.agents.map(id => p.agents.find(a => a.id === id)?.name ?? id).join(', ')}` : 'Every agent'} · stops after {h.timeout} s</small>
    </div>)}</>
  }
  function hooksContent(p: PersonalPlugin): React.JSX.Element {
    if (!p.hooks.length) return <><h4>Hooks in this plugin</h4></>
    return <><h4>Hooks in this plugin</h4>
      {hookList(p)}
    </>
  }
  function detail(p: PersonalPlugin): React.JSX.Element {
    if (skill) return skillContent(p, skill)
    if (subagent) return subagentContent(p, subagent)
    if (tab === 'overview') return overview(p)
    if (tab === 'skills') return <><h4>Skills in this plugin</h4>{skillList(p)}</>
    if (tab === 'subagents') return <><h4>Subagents in this plugin</h4>{subagentList(p)}</>
    if (tab === 'hooks') return hooksContent(p)
    if (tab === 'tools') return tools(p)
    return agents(p)
  }
  const tabs: Tab[] = ['overview', 'skills', 'subagents', 'hooks', 'tools', 'agents']
  return <main className="plugins-screen"><section className="plugin-settings" aria-label="Plugins">
    <header className="plugin-library-header"><div><h2>Plugins</h2><p>To create, import or change a plugin, ask any session to use Gloss’s plugins skill (<code>gloss:new-plugin</code>), or edit its files in the library folder.</p></div></header>
    {!dialog && error && <p className="plugin-error" role="alert">{error}</p>}{!dialog && state?.errors.map(e => <p className="plugin-error" role="alert" key={e}>{e}</p>)}
    <div className="plugin-workspace" ref={workspace}><div className="plugin-library">
      <div className="plugin-toolbar"><label className="plugin-search"><Search /><input aria-label="Find a plugin" placeholder="Find a plugin…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      <div className="plugin-list">{shown.map(p => <button key={p.id} className={`plugin-list-item ${p.id === plugin?.id ? 'selected' : ''}`} aria-pressed={p.id === plugin?.id} onClick={() => select(p.id)}><span className="plugin-package-mark"><Package /></span><span><strong>{p.name}</strong><span>{p.description}</span><small>{p.builtin ? 'Built in · always on' : p.problems.length ? 'Needs attention' : summary(p)}</small></span></button>)}
        {!state && !error && <p className="plugin-empty">Loading plugins…</p>}
        {state && !shown.some(p => !p.builtin) && <div className="plugin-empty"><Package /><h3>{query && state.plugins.some(p => !p.builtin) ? 'No matching plugins' : 'No plugins of your own yet'}</h3>{query && state.plugins.some(p => !p.builtin) && <button className="secondary" onClick={() => setQuery('')}>Clear search</button>}</div>}
      </div>
      <button className="plugin-library-folder plugin-link" disabled={isPending('folder:library')} onClick={() => run('folder:library', () => window.gloss.plugins.openFolder(), false)}><FolderOpen />Open library folder</button>
    </div>
    <ResizeHandle label="Resize plugin details" pane="after" limits={detailLimits} value={detailWidth === null ? null : clampWidth(detailWidth, detailLimits)} onResize={setDetailWidth} onReset={() => setDetailWidth(null)} />
    <aside className="plugin-detail" style={detailWidth === null ? undefined : { '--plugin-detail-width': `${clampWidth(detailWidth, detailLimits)}px` } as React.CSSProperties} aria-label="Plugin details">{plugin ? <>
      <header><div className="plugin-inline-heading"><h3>{plugin.name}</h3>{!plugin.builtin && <button className="icon-button" aria-label="Open plugin folder" title="Open plugin folder" disabled={isPending(`folder:${plugin.id}`)} onClick={() => run(`folder:${plugin.id}`, () => window.gloss.plugins.openFolder(plugin.id), false)}><FolderOpen /></button>}</div><p>{plugin.description}</p>{plugin.builtin && <p className="muted">Gloss maintains this plugin and updates it with each version. It’s read-only and on for every agent.</p>}</header>
      <nav className="plugin-tabs" aria-label="Plugin sections">{tabs.map(t => <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => { resetDetail(); setTab(t) }}>{TAB_LABELS[t]}</button>)}</nav>
      <div className="plugin-detail-content">{!dialog && plugin.problems.map(problem => <p className="plugin-error" role="alert" key={problem}>{problem}</p>)}{detail(plugin)}</div>
    </> : <div className="plugin-empty"><Package /><h3>One place for each workflow</h3></div>}</aside></div>
    {dialog && <PluginDialog key={dialog.kind + ('plugin' in dialog ? dialog.plugin.id : '')} dialog={dialog} busy={isPending('dialog')} onClose={() => setDialog(null)} onSubmit={async directory => {
      if (pendingRef.current.has('dialog')) return
      await execute('dialog', () => dialog.kind === 'custom'
        ? window.gloss.plugins.setSkillDirectory(dialog.agent.id, directory)
        : window.gloss.plugins.enable(dialog.plugin.id, dialog.agent.id, true), false)
      setDialog(null)
    }} />}
  </section></main>
}

/** Turning on hooks, or setting a custom agent's skill directory. */
function PluginDialog({ dialog, busy, onClose, onSubmit }: { dialog: Dialog; busy: boolean; onClose(): void; onSubmit(directory: string): Promise<void> }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [directory, setDirectory] = useState(dialog.kind === 'custom' ? dialog.agent.skillDirectory ?? '' : '')
  const [error, setError] = useState<string | null>(null)
  const [confirmedFormat, setConfirmedFormat] = useState(dialog.kind === 'custom' && !!dialog.agent.skillDirectory)
  const close = useRef(onClose); close.current = onClose
  const submitting = useRef(busy); submitting.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ;(ref.current?.querySelector('input') as HTMLElement | null ?? ref.current?.querySelector('button'))?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!submitting.current) close.current() }
      if (e.key === 'Tab') {
        const fields = [...ref.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')]
        const first = fields[0], last = fields.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus() }
  }, [])
  const custom = dialog.kind === 'custom'
  const disabled = busy || custom && (!confirmedFormat || !directory.trim())
  return createPortal(<div className="dialog-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}><div className="dialog plugin-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title">
    <div className="plugin-inline-heading"><h2 id="plugin-dialog-title">{custom ? 'Custom agent skills' : 'Turn on hooks?'}</h2><button className="icon-button" disabled={busy} aria-label="Close dialog" onClick={onClose}><X /></button></div>
    <form onSubmit={e => { e.preventDefault(); if (!disabled) { setError(null); void onSubmit(directory).catch(err => setError(errorText(err))) } }}>
      {dialog.kind === 'custom' ? <><p>{dialog.agent.name} needs its own skill directory. This configures skill delivery only; it does not establish native plugin or remote MCP support.</p>
        <label className="plugin-form-field"><span>Absolute skill-directory path</span><input disabled={busy} value={directory} onChange={e => setDirectory(e.target.value)} /></label>
        <label className="plugin-connection-choice"><input type="checkbox" disabled={busy} checked={confirmedFormat} onChange={e => setConfirmedFormat(e.target.checked)} />This agent supports SKILL.md skill folders.</label>
        <p>Gloss creates only its own namespaced links here. Existing files are preserved. Turn off this agent’s plugins before changing the directory.</p></>
        : <><p><strong>{dialog.plugin.name}</strong> has hooks: {dialog.agent.name} will run these commands automatically, with your permissions, in its sessions.</p>
          <ul className="plugin-hook-confirm">{hooksFor(dialog.plugin, dialog.agent.id).map((h, i) => <li key={i}><span>{EVENTS[h.event] ?? h.event}{toolLabel(h) ? ` · ${toolLabel(h)}` : ''}</span><code>{h.command}</code></li>)}</ul></>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={disabled}>{busy ? 'Saving…' : custom ? 'Save directory' : 'Turn on'}</button></div>
    </form>
  </div></div>, document.body)
}
