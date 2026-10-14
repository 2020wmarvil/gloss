import { useEffect, useState } from 'react'
import type { SettingsPatch, SettingsState } from '@shared/ipc'
import { SETTING_FIELDS, type GlobalSettings, type SettingField } from '@shared/settings'
import { errorText } from './errors'
import { modKey, SHORTCUTS } from './shortcuts'
import { projectMcp } from '@shared/mcp'
import { McpSettings } from './McpSettings'

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
          <h2 className="label">Global</h2>
          {SETTING_FIELDS.filter((f) => f.scope === 'global' && !f.hidden).map((f) => (
            <Field
              key={f.key}
              field={f}
              value={state.global[f.key as keyof GlobalSettings]}
              onChange={(value) => void update({ global: { [f.key]: value } })}
            />
          ))}
        </section>

        <section>
          <h2 className="label">Project</h2>
          {projectPath ? (
            <>
              <p className="mono">{projectPath}</p>
              <McpSettings key={projectPath} servers={projectMcp(state.projects, projectPath)}
                onSave={async (mcpServers) => { await onUpdate({ project: { path: projectPath, values: { mcpServers } } }) }} />
              {projectFields.length === 0 && <p className="muted">No project settings yet.</p>}
            </>
          ) : (
            <p className="muted">Open a session to see its project&apos;s settings.</p>
          )}
        </section>

        <section>
          <h2 className="label">Keyboard shortcuts</h2>
          <Shortcuts />
        </section>

        <section>
          <h2 className="label">Settings file</h2>
          <div className="settings-file">
            <span className="mono" title={state.path}>
              {state.path}
            </span>
            <button onClick={() => void openFile()}>Open in editor</button>
          </div>
          {openError && <p className="settings-problem">Couldn&apos;t open the file: {openError}</p>}
        </section>
      </div>
    </main>
  )
}

function Shortcuts(): React.JSX.Element {
  const mod = modKey()
  return (
    <>
      {SHORTCUTS.map((group) => (
        <div key={group.title} className="shortcut-group">
          <h2>{group.title}</h2>
          <dl>
            {group.shortcuts.map((s) => (
              <div key={s.action} className="shortcut">
                <dt className="shortcut-keys">
                  {s.keys.map((combo, i) => (
                    <span className="shortcut-combo" key={i}>
                      {i > 0 && <span className="shortcut-or muted">or</span>}
                      {combo.map((k, j) => (
                        <span key={j}>
                          {j > 0 && '+'}
                          <kbd>{k === 'Mod' ? mod : k}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </dt>
                <dd>{s.action}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  )
}

function Field(props: { field: SettingField; value: unknown; onChange(value: unknown): void }): React.JSX.Element {
  const { field, value } = props
  const id = `setting-${field.key}`
  return (
    <div className="setting">
      <div className="setting-copy">
        <label className="setting-label" htmlFor={id}>
          {field.label}
        </label>
        <p className="setting-desc" id={`${id}-description`}>
          {field.description}
        </p>
      </div>
      {field.type === 'enum' ? (
        <select
          id={id}
          aria-describedby={`${id}-description`}
          value={String(value)}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="checkbox"
          aria-describedby={`${id}-description`}
          checked={value === true}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      )}
    </div>
  )
}
