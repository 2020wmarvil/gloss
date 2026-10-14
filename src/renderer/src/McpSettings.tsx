import { useState } from 'react'
import { mcpError, mcpName, type McpImportPreview, type McpImportSource, type McpServer } from '@shared/mcp'
import { errorText } from './errors'

type Props = { servers: McpServer[]; hasLegacy?: boolean; onSave(servers: McpServer[]): Promise<void> }
type Draft = { name: string; type: 'stdio' | 'http' | 'sse'; command: string; args: string; env: string; url: string; headers: string }
const blank: Draft = { name: '', type: 'stdio', command: '', args: '[]', env: '{}', url: '', headers: '{}' }
const pairText = (pairs: { name: string; value: string }[]): string => JSON.stringify(Object.fromEntries(pairs.map((p) => [p.name, p.value])), null, 2)
function readPairs(text: string): { name: string; value: string }[] {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) throw new Error('Use a JSON object with string values for environment variables and headers.')
  return Object.entries(value).map(([name, value]) => ({ name, value: value as string }))
}
function describe(server: McpServer): string {
  if (!('type' in server)) return server.command
  try { const url = new URL(server.url); return `${url.origin}${url.pathname}` } catch { return server.type }
}

export function McpSettings({ servers, onSave, hasLegacy }: Props): React.JSX.Element {
  const [editor, setEditor] = useState<{ index: number; draft: Draft } | null>(null)
  const [preview, setPreview] = useState<McpImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  function reset(): void { setError(null); setStatus(null) }
  async function save(next: McpServer[], message: string): Promise<void> {
    const problem = mcpError(next)
    if (problem) { setError(problem); return }
    setBusy(true); reset()
    try { await onSave(next); setEditor(null); setPreview(null); setStatus(message) }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  function edit(index: number): void {
    reset(); setPreview(null)
    const server = servers[index]
    setEditor({ index, draft: !server ? { ...blank } : 'type' in server
      ? { ...blank, name: server.name, type: server.type, url: server.url, headers: pairText(server.headers) }
      : { ...blank, name: server.name, command: server.command, args: JSON.stringify(server.args, null, 2), env: pairText(server.env) } })
  }
  function field(key: keyof Draft, value: string): void {
    setEditor((current) => current && ({ ...current, draft: { ...current.draft, [key]: value } }))
  }
  function saveEditor(): void {
    if (!editor) return
    try {
      const d = editor.draft
      const server: McpServer = d.type === 'stdio'
        ? { name: d.name, command: d.command, args: JSON.parse(d.args) as string[], env: readPairs(d.env) }
        : { name: d.name, type: d.type, url: d.url, headers: readPairs(d.headers) }
      const next = [...servers]
      if (editor.index < 0) next.push(server)
      else next[editor.index] = server
      void save(next, 'Server saved.')
    } catch (err) { setError(errorText(err)) }
  }
  async function discover(source: McpImportSource): Promise<void> {
    setBusy(true); reset(); setEditor(null); setPreview(null)
    try {
      const result = await window.gloss.settings.previewMcpImport(source)
      setPreview(result)
      setNames(Object.fromEntries(result.entries.map((e) => [e.id, e.name])))
      const used = new Set(servers.map((s) => mcpName(s.name)))
      const checked = new Set<string>()
      for (const entry of result.entries) if (entry.server && !used.has(mcpName(entry.name))) {
        used.add(mcpName(entry.name)); checked.add(entry.id)
      }
      setSelected(checked)
    } catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  const imports = (preview?.entries ?? []).flatMap((e) => selected.has(e.id) && e.server ? [{ ...e.server, name: names[e.id] ?? e.name }] : [])
  const importProblem = mcpError([...servers, ...imports])
  return <div className="mcp-settings">
    <h3>MCP servers</h3>
    <p className="setting-desc">Shared by Claude Code and Codex in all projects. Changes apply on the next turn or resume.</p>
    <p className="setting-desc">Every listed server is included. Agent-owned servers may also load independently. Codex does not support SSE.</p>
    <div className="mcp-actions">
      <button disabled={busy} onClick={() => edit(-1)}>Add server</button>
      <button disabled={busy} onClick={() => void discover('claude')}>Import from Claude</button>
      <button disabled={busy} onClick={() => void discover('codex')}>Import from Codex</button>
      {hasLegacy && <button disabled={busy} onClick={() => void discover('gloss')}>Import old project servers</button>}
    </div>
    {servers.length === 0 && <p className="muted">No shared MCP servers yet.</p>}
    <ul className="mcp-server-list">{servers.map((server, index) => <li key={server.name}>
      <div><strong>{server.name}</strong><span className="muted">{'type' in server ? server.type.toUpperCase() : 'stdio'}</span><p className="mono">{describe(server)}</p></div>
      <button disabled={busy} onClick={() => edit(index)} aria-label={`Edit ${server.name}`}>Edit</button>
      <button disabled={busy} onClick={() => void save(servers.filter((_, i) => i !== index), 'Server removed from Gloss. Native agent settings are unchanged.')} aria-label={`Remove ${server.name}`}>Remove</button>
    </li>)}</ul>
    {editor && <form className="mcp-editor" onSubmit={(e) => { e.preventDefault(); saveEditor() }}>
      <h4>{editor.index < 0 ? 'Add server' : 'Edit server'}</h4>
      <label>Name<input required value={editor.draft.name} disabled={busy} onChange={(e) => field('name', e.target.value)} autoFocus /></label>
      <label>Transport<select value={editor.draft.type} disabled={busy} onChange={(e) => field('type', e.target.value)}><option value="stdio">stdio (local command)</option><option value="http">HTTP</option><option value="sse">SSE (Claude only)</option></select></label>
      {editor.draft.type === 'stdio' ? <>
        <label>Command<input required value={editor.draft.command} disabled={busy} onChange={(e) => field('command', e.target.value)} placeholder="C:/tools/mcp-server.exe" /></label>
        <label>Arguments (JSON list)<textarea rows={3} value={editor.draft.args} disabled={busy} onChange={(e) => field('args', e.target.value)} /></label>
        <label>Environment variables (JSON object)<textarea rows={3} value={editor.draft.env} disabled={busy} onChange={(e) => field('env', e.target.value)} /></label>
      </> : <>
        <label>URL<input required type="url" value={editor.draft.url} disabled={busy} onChange={(e) => field('url', e.target.value)} placeholder="http://127.0.0.1:8080/mcp" /></label>
        <label>Headers (JSON object)<textarea rows={3} value={editor.draft.headers} disabled={busy} onChange={(e) => field('headers', e.target.value)} /></label>
      </>}
      <div className="mcp-actions"><button type="submit" disabled={busy}>Save server</button><button type="button" disabled={busy} onClick={() => { setEditor(null); reset() }}>Cancel</button></div>
    </form>}
    {preview && <div className="mcp-import-preview">
      <h4>Review import</h4>
      <p className="setting-desc">Selected servers will be copied into Gloss for all projects. Original files stay unchanged. Environment-based credentials are copied as current values; OAuth sign-ins are not transferred.</p>
      {preview.entries.length === 0 && <p>No MCP servers found.</p>}
      {preview.problems.map((problem, i) => <p className="settings-problem" key={i}>{problem}</p>)}
      {preview.entries.map((entry) => <div key={entry.id} className="mcp-import-entry">
        <label><input type="checkbox" disabled={busy || !entry.server} checked={selected.has(entry.id)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(entry.id); else next.delete(entry.id); setSelected(next) }} />{entry.name}</label>
        <p className="muted mono">{entry.source}</p>
        {entry.server && <><p className="mono">{describe(entry.server)}</p><label>Import as<input aria-label={`Import ${entry.name} as (${entry.id})`} disabled={busy} value={names[entry.id] ?? entry.name} onChange={(e) => setNames((old) => ({ ...old, [entry.id]: e.target.value }))} /></label></>}
        {entry.problem && <p className="settings-problem">{entry.problem}</p>}
        {entry.server && servers.some((s) => mcpName(s.name) === mcpName(names[entry.id] ?? entry.name)) && <p className="muted">This name already exists. Rename it to import another copy.</p>}
        {entry.server && 'type' in entry.server && entry.server.type === 'sse' && <p className="settings-problem">SSE is unsupported by Codex.</p>}
      </div>)}
      {imports.length > 0 && importProblem && <p className="settings-problem">{importProblem}</p>}
      <div className="mcp-actions"><button disabled={busy || imports.length === 0 || !!importProblem} onClick={() => void save([...servers, ...imports], `Imported ${imports.length} server${imports.length === 1 ? '' : 's'}.`)}>Import selected ({imports.length})</button><button disabled={busy} onClick={() => { setPreview(null); reset() }}>Cancel import</button></div>
    </div>}
    {busy && <p role="status">Working...</p>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert" className="settings-problem">{error}</p>}
  </div>
}
