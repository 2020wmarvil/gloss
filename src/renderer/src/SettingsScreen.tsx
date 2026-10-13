import { useEffect, useState } from 'react'
import type { SettingsPatch, SettingsState } from '@shared/ipc'
import { SETTING_FIELDS, type GlobalSettings, type SettingField } from '@shared/settings'
import { errorText } from './errors'

type Props = {
  state: SettingsState
  /** The open session's folder, if any. */
  projectPath: string | null
  onUpdate(patch: SettingsPatch): Promise<void>
  onOpenFile(): Promise<string | null>
  onClose(): void
}

export function SettingsScreen({ state, projectPath, onUpdate, onOpenFile, onClose }: Props): React.JSX.Element {
  const [saveError, setSaveError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A failed save is stale once the settings change (say, the file was fixed in an editor).
  useEffect(() => setSaveError(null), [state])

  async function update(patch: SettingsPatch): Promise<void> {
    setSaveError(null)
    try {
      await onUpdate(patch)
    } catch (err) {
      setSaveError(errorText(err))
    }
  }

  async function openFile(): Promise<void> {
    setOpenError(await onOpenFile())
  }

  const projectFields = SETTING_FIELDS.filter((f) => f.scope === 'project')

  return (
    <main className="settings">
      <header>
        <h1>Settings</h1>
        <button className="settings-close" onClick={onClose} title="Close (Esc)">
          Done
        </button>
      </header>
      <div className="settings-body">
        {state.error && (
          <div className="settings-problem" role="alert">
            <p>
              <strong>settings.json has a problem.</strong> Gloss is using the last good settings until
              it&apos;s fixed.
            </p>
            <pre>{state.error}</pre>
          </div>
        )}
        {saveError && <p className="settings-problem">{saveError}</p>}

        <section>
          <div className="label">File</div>
          <div className="settings-file">
            <span className="mono" title={state.path}>
              {state.path}
            </span>
            <button onClick={() => void openFile()}>Open in editor</button>
          </div>
          {openError && <p className="settings-problem">Couldn&apos;t open the file: {openError}</p>}
        </section>

        <section>
          <div className="label">Global</div>
          {SETTING_FIELDS.filter((f) => f.scope === 'global').map((f) => (
            <Field
              key={f.key}
              field={f}
              value={state.global[f.key as keyof GlobalSettings]}
              onChange={(value) => void update({ global: { [f.key]: value } })}
            />
          ))}
        </section>

        <section>
          <div className="label">Project</div>
          {projectPath ? (
            <>
              <p className="mono">{projectPath}</p>
              {projectFields.length === 0 && <p className="muted">No project settings yet.</p>}
            </>
          ) : (
            <p className="muted">Open a session to see its project&apos;s settings.</p>
          )}
        </section>
      </div>
    </main>
  )
}

function Field(props: { field: SettingField; value: unknown; onChange(value: unknown): void }): React.JSX.Element {
  const { field, value } = props
  switch (field.type) {
    case 'enum':
      return (
        <label className="setting">
          <span className="setting-control">
            <select value={String(value)} onChange={(e) => props.onChange(e.target.value)}>
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
          <span>
            <span className="setting-label">{field.label}</span>
            <span className="setting-desc">{field.description}</span>
            <span className="setting-key mono">{field.key}</span>
          </span>
        </label>
      )
    case 'boolean':
      return (
        <label className="setting">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <span>
            <span className="setting-label">{field.label}</span>
            <span className="setting-desc">{field.description}</span>
            <span className="setting-key mono">{field.key}</span>
          </span>
        </label>
      )
  }
}
