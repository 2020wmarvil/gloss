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

  return <section className="opencode-settings">
    <h2 className="label">OpenCode</h2>
    <p className="setting-desc">Use OpenCode v2 with its existing providers and models, including local models served by Ollama. Test the connection to save this setup.</p>
    <label htmlFor="opencode-executable" className="setting-label">Executable path</label>
    <input id="opencode-executable" className="setting-text" type="text" spellCheck={false}
      placeholder="Find installed OpenCode automatically" value={draft} disabled={busy}
      onChange={(e) => { setDraft(e.target.value); setStatus(null); setError(null) }} />
    <button disabled={busy} onClick={() => void test()}>{busy ? 'Connecting…' : 'Test connection and save'}</button>
    {status?.available && <p role="status">Connected to OpenCode {status.version}.<br /><span className="mono">{status.executable}</span></p>}
    {(error || status?.error) && <p role="alert" className="settings-problem">{error ?? status?.error}</p>}
    <p className="setting-desc">Leave the path empty to discover a native executable on PATH or an OpenCode Desktop installation on Windows. Changes apply after running turns finish. The test does not send a prompt or call a model.</p>
    <p className="setting-desc">Configure providers in OpenCode. Keep Ollama running for local models; OpenCode supplies the available models to Gloss.</p>
    <p><a href="https://opencode.ai/download">Install OpenCode</a> · <a href="https://docs.ollama.com/integrations/opencode">Ollama setup</a></p>
  </section>
}
