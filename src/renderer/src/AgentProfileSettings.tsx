import { useEffect, useRef, useState } from 'react'
import { profileError, type AgentProfile } from '@shared/agentProfiles'
import type { AgentProfileStatus } from '@shared/ipc'
import { ArrowLeft, CheckCircle2, ChevronRight, Ellipsis, Plus, Trash2 } from 'lucide-react'
import { errorText } from './errors'
import { Popover } from './Popover'

type Props = {
  profiles: AgentProfile[]
  defaultAgent: string
  onSave(profiles: AgentProfile[], resetDefault?: boolean): Promise<void>
}

export function AgentProfileSettings({ profiles, defaultAgent, onSave }: Props): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentProfile | null>(null)
  const [args, setArgs] = useState('[]')
  const [env, setEnv] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<AgentProfileStatus | null>(null)
  const [statusName, setStatusName] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)

  useEffect(() => {
    if (draft || !returnFocus.current) return
    returnFocus.current = false
    const row = [...(list.current?.querySelectorAll<HTMLButtonElement>('.acp-open') ?? [])].find((button) => button.dataset.profileId === editing)
    ;(row ?? addButton.current)?.focus()
  }, [draft, editing])

  function closeEditor(): void {
    returnFocus.current = true
    setDraft(null); setError(null); setStatus(null)
  }

  function edit(profile?: AgentProfile): void {
    setEditing(profile?.id ?? null)
    setDraft(profile ?? { id: generatedId('', profiles), name: '', command: '', args: [], env: {} })
    setArgs(JSON.stringify(profile?.args ?? [], null, 2))
    setEnv(JSON.stringify(profile?.env ?? {}, null, 2))
    setStatus(null)
    setError(null)
  }

  async function save(): Promise<void> {
    if (!draft) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      let parsedArgs: unknown, parsedEnv: unknown
      try { parsedArgs = JSON.parse(args); parsedEnv = JSON.parse(env) } catch { throw new Error('Arguments and environment references must be valid JSON.') }
      const candidate = { ...draft, name: draft.name.trim(), command: draft.command.trim(), args: parsedArgs, env: parsedEnv }
      const validation = profileError(candidate)
      if (validation) throw new Error(validation)
      const profile = candidate as AgentProfile
      if (profiles.some((p) => p.id === profile.id && p.id !== editing)) throw new Error('That profile ID already exists. Choose another ID or edit the existing profile.')
      const result = await window.gloss.agents.testProfile(profile)
      if (!result.available) { setStatus(result); return }
      await onSave(editing ? profiles.map((p) => p.id === editing ? profile : p) : [...profiles, profile])
      setStatusName(profile.name)
      setStatus(result)
      returnFocus.current = true
      setDraft(null)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try { await onSave(profiles.filter((p) => p.id !== id), id === defaultAgent) }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }

  return <section className="agent-profile-settings" aria-labelledby="settings-custom-agents">
    <header className="acp-heading">
      <h3 id="settings-custom-agents">Custom ACP agents</h3>
      {!draft && <button ref={addButton} className="secondary sm" disabled={busy} onClick={() => edit()}><Plus />Add agent</button>}
    </header>
    {!draft && <ul ref={list} className="acp-list settings-card" aria-label="Custom ACP agents">
      {profiles.map((p) => <li className="acp-row" key={p.id}>
        <button className="acp-open" data-profile-id={p.id} disabled={busy} aria-label={`Edit ${p.name}`} onClick={() => edit(p)}>
          <span className="acp-identity"><span className="acp-name">{p.name}{p.id === defaultAgent && <span className="acp-default">Default</span>}</span>
            <span className="acp-command" title={p.command}>{p.command.split(/[/\\]/).at(-1)}</span></span>
          <ChevronRight />
        </button>
        <Popover label={<><Ellipsis /><span className="sr-only">Actions for {p.name}</span></>} title={`Actions for ${p.name}`} className="icon-button" down disabled={busy}>
          {(close) => <button className="ghost acp-remove" disabled={busy} onClick={() => { close(); void remove(p.id) }}><Trash2 />Remove agent</button>}
        </Popover>
      </li>)}
      {profiles.length === 0 && <li className="acp-empty">No custom agents yet.</li>}
    </ul>}
    {draft && <form className="acp-editor" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <fieldset disabled={busy}>
        <legend className="sr-only">{editing ? 'Edit agent' : 'Add agent'}</legend>
        <div className="acp-editor-heading"><button className="ghost sm" type="button" onClick={closeEditor}><ArrowLeft />All agents</button><span>{editing ? 'Edit agent' : 'Add agent'}</span></div>
        <div className="settings-card">
          <div className="setting"><label htmlFor="profile-name" className="setting-label">Name</label>
            <input id="profile-name" className="setting-text" value={draft.name} autoFocus onChange={(e) => {
              const name = e.target.value
              setDraft({ ...draft, name, ...(!editing && draft.id === generatedId(draft.name, profiles) ? { id: generatedId(name, profiles) } : {}) })
            }} /></div>
          <div className="setting"><label htmlFor="profile-command" className="setting-label">Executable</label>
            <input id="profile-command" className="setting-text" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></div>
          <div className="setting acp-wide"><div className="setting-copy"><label htmlFor="profile-args" className="setting-label">Arguments</label>
            <p className="setting-desc">JSON array. Use {'{instructions}'} for the instruction file.</p></div>
            <textarea id="profile-args" className="setting-text mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'["acp", "--instructions", "{instructions}"]'} /></div>
        </div>
        <details className="acp-advanced"><summary>Advanced</summary>
        <div className="settings-card">
        <div className="setting"><div className="setting-copy"><label htmlFor="profile-id" className="setting-label">Profile ID</label>
          <p className="setting-desc">Keep this ID to restore conversations.</p></div>
          <input id="profile-id" className="setting-text" value={draft.id} disabled={editing !== null} onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></div>
        <div className="setting acp-wide"><div className="setting-copy">
        <label htmlFor="profile-instructions-env">Instruction environment variable (optional)</label>
        <p className="setting-desc">For agents that accept the file path through an environment variable.</p></div>
        <input id="profile-instructions-env" className="setting-text" value={draft.instructionsEnv ?? ''} onChange={(e) => setDraft({ ...draft, instructionsEnv: e.target.value || undefined })} />
        </div>
        <div className="setting acp-wide"><div className="setting-copy"><label htmlFor="profile-env" className="setting-label">Environment references</label>
          <p className="setting-desc">Map variable names, never secrets. Restart Gloss after environment changes.</p></div>
          <textarea id="profile-env" className="setting-text mono" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={'{"API_KEY": "MY_AGENT_KEY"}'} /></div>
        </div></details>
        <div className="acp-form-actions"><button className="primary" type="submit">{busy ? 'Connecting...' : 'Test and save'}</button>
          <button className="ghost" type="button" onClick={closeEditor}>Cancel</button></div>
      </fieldset>
    </form>}
    {(error || status?.error) && <p className="settings-problem" role="alert">{error ?? status?.error}</p>}
    {status?.available && <div className="acp-result" role="status"><p><CheckCircle2 />{statusName} saved{status.version ? ` (v${status.version})` : ''}.</p>
      {status.capabilities && <details><summary>Connection details</summary><dl>
        {Object.entries(status.capabilities).map(([name, enabled]) => <div key={name}><dt>{({ resume: 'Resume', discovery: 'Session discovery', steering: 'Steering', images: 'Images', context: 'File attachments' } as Record<string, string>)[name]}</dt><dd>{enabled ? 'Available' : 'Unavailable'}</dd></div>)}
      </dl><p className="setting-desc">No model calls. Verify that the agent reads its instructions.</p>
      {!status.capabilities.resume && <p className="setting-desc">Resume unavailable. Start a new conversation after restart.</p>}</details>}
    </div>}
  </section>
}

function generatedId(name: string, profiles: AgentProfile[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'agent'
  const base = `custom:${slug}`
  let id = base
  for (let suffix = 2; profiles.some((p) => p.id === id); suffix++) id = `${base}-${suffix}`
  return id
}
