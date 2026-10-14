import { useEffect, useState } from 'react'
import { mcpError, type McpServer } from '@shared/mcp'
import { errorText } from './errors'

export function McpSettings({ servers, onSave }: { servers: McpServer[]; onSave(servers: McpServer[]): Promise<void> }): React.JSX.Element {
  const saved = JSON.stringify(servers, null, 2)
  const [text, setText] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setText(saved); setError(null) }, [saved])
  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const value: unknown = JSON.parse(text)
      const problem = mcpError(value)
      if (problem) throw new Error(problem)
      await onSave(value as McpServer[])
    } catch (err) { setError(errorText(err)) }
    finally { setSaving(false) }
  }
  return <div className="mcp-settings">
    <label className="setting-label" htmlFor="mcp-servers">MCP servers</label>
    <p className="setting-desc">Tools shared by Claude Code and Codex in this project. Changes apply on the next turn or resume.</p>
    <p className="setting-desc">Use a list of server objects. Stdio: name, command, args and env. Remote: type (http or sse), name, url and headers. Codex does not support SSE.</p>
    <textarea id="mcp-servers" className="mono" rows={10} spellCheck={false} value={text} disabled={saving} onChange={(e) => setText(e.target.value)} />
    <details><summary>Examples</summary><pre>{JSON.stringify([
      { name: 'local-tools', command: 'C:/tools/mcp-server.exe', args: [], env: [] },
      { type: 'http', name: 'remote-tools', url: 'https://example.com/mcp', headers: [] }
    ], null, 2)}</pre></details>
    {error && <p role="alert" className="settings-problem">{error}</p>}
    <button disabled={saving || text === saved} onClick={() => void save()}>{saving ? 'Saving...' : 'Save MCP servers'}</button>
  </div>
}
