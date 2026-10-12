// M1: a bare page that drives the ACP spike and shows its streamed output.
import { useEffect, useState } from 'react'
import type { GlossEvent, Settings } from '@shared/ipc'

type ToolRow = { id: string; title: string; status: string }

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [running, setRunning] = useState(false)
  const [agentText, setAgentText] = useState('')
  const [tools, setTools] = useState<ToolRow[]>([])
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    void window.gloss.settings.get().then(setSettings)
    return window.gloss.onEvent((event) => handleEvent(event))
  }, [])

  function handleEvent(event: GlossEvent): void {
    switch (event.type) {
      case 'log':
        setLog((l) => [...l, `${event.level === 'error' ? 'ERROR ' : ''}${event.text}`])
        break
      case 'capabilities':
        setLog((l) => [...l, `capabilities: ${JSON.stringify(event.agentCapabilities)}`])
        break
      case 'turn-end':
        setLog((l) => [...l, `stopReason: ${event.stopReason}`])
        break
      case 'update': {
        const u = event.update
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
          const text = u.content.text
          setAgentText((t) => t + text)
        } else if (u.sessionUpdate === 'tool_call') {
          setTools((ts) => [...ts, { id: u.toolCallId, title: u.title, status: u.status ?? 'pending' }])
        } else if (u.sessionUpdate === 'tool_call_update') {
          setTools((ts) =>
            ts.map((t) =>
              t.id === u.toolCallId
                ? { ...t, title: u.title ?? t.title, status: u.status ?? t.status }
                : t
            )
          )
        }
        setLog((l) => [...l, `session/update: ${u.sessionUpdate}`])
        break
      }
    }
  }

  async function run(): Promise<void> {
    setRunning(true)
    setAgentText('')
    setTools([])
    setLog([])
    try {
      await window.gloss.spike.run()
    } catch {
      // The error is already reported through the event log.
    } finally {
      setRunning(false)
    }
  }

  async function toggleDevModel(on: boolean): Promise<void> {
    setSettings(await window.gloss.settings.setDevModel(on))
  }

  return (
    <div className="spike">
      <header>
        <h1>Gloss</h1>
        <span className="muted">M1 · ACP spike</span>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings?.devModel ?? false}
            disabled={settings === null || running}
            onChange={(e) => void toggleDevModel(e.target.checked)}
          />
          Dev model (Haiku)
        </label>
        <button onClick={() => void run()} disabled={running}>
          {running ? 'Running…' : 'Run spike prompt'}
        </button>
      </header>

      <section>
        <h2>Agent</h2>
        <pre className="agent">{agentText || <span className="muted">No output yet.</span>}</pre>
        {tools.length > 0 && (
          <ul className="tools">
            {tools.map((t) => (
              <li key={t.id}>
                {t.title} <span className="muted">({t.status})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Log</h2>
        <pre className="log">{log.join('\n')}</pre>
      </section>
    </div>
  )
}
