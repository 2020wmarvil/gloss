import { useEffect, useState } from 'react'
import type { OpenCodeStatus } from '@shared/ipc'
import { errorText } from './errors'

export function OpenCodeSettings(props: { executable: string; onSave(executable: string): Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState(props.executable)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<OpenCodeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setDraft(props.executable); setStatus(null) }, [props.executable])

  async function test(): Promise<void> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const result = await window.gloss.agents.testOpenCode(draft.trim())
      if (result.available) await props.onSave(draft.trim())
      setStatus(result)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return <section className="opencode-settings" aria-labelledby="settings-opencode">
    <h3 id="settings-opencode">OpenCode</h3>
    <p className="lede">Use OpenCode v2 with hosted or local models.</p>
    <label htmlFor="opencode-executable" className="setting-label">Executable path</label>
    <input id="opencode-executable" className="setting-text" type="text" spellCheck={false}
      placeholder="Find installed OpenCode automatically" value={draft} disabled={busy}
      onChange={(e) => { setDraft(e.target.value); setStatus(null); setError(null) }} />
    <button className="secondary" disabled={busy} onClick={() => void test()}>{busy ? 'Connecting…' : 'Test connection and save'}</button>
    {status?.available && <p role="status">Connected to OpenCode {status.version}.<br /><span className="mono">{status.executable}</span></p>}
    {(error || status?.error) && <p role="alert" className="settings-problem">{error ?? status?.error}</p>}
    <p className="setting-desc">Empty finds an installed executable. Changes wait for running turns. Testing makes no model calls.</p>
    <p className="setting-desc">Configure models in OpenCode. Keep Ollama running with 64K+ context; check with <code>ollama ps</code>.</p>
    <p><a href="https://opencode.ai/download">Install OpenCode</a> · <a href="https://docs.ollama.com/integrations/opencode">Ollama setup</a></p>
  </section>
}
