// The settings screen (docs/mocks/target.html#settings): a list of sections on the left,
// one section at a time on the right, each a card of rows with one control each.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPatch, SettingsState } from '@shared/ipc'
import type { Project } from '@shared/types'
import { folderName, sameFolder } from '@shared/paths'
import { SETTING_FIELDS, projectSettings, type ProjectSettings, type GlobalSettings, type SettingField } from '@shared/settings'
import { errorText } from './errors'
import { modKey, SHORTCUTS } from './shortcuts'
import { McpSettings } from './McpSettings'
import { OpenCodeSettings } from './OpenCodeSettings'
import { AgentProfileSettings } from './AgentProfileSettings'
import { PluginSettings } from './PluginSettings'
import { Segmented, Select, Switch } from './Select'
import { EditorSetting } from './EditorSetting'
import { ShortcutSetting } from './ShortcutSetting'
import { PhoneSettings } from './PhoneSettings'
import { ExternalLink, Folder, Keyboard, Package, Palette, Server, SlidersVertical, Smartphone, Terminal } from 'lucide-react'

export type SettingsSection = 'general' | 'appearance' | 'mcp' | 'agents' | 'plugins' | 'phone' | 'project' | 'shortcuts'

/** Fields shown in Appearance; the other visible global fields are General. */
const APPEARANCE = new Set(['theme'])
/** Enum fields shown as a segmented control rather than a dropdown. */
const SEGMENTED = new Set(['theme'])

type Props = {
  state: SettingsState
  /** The initially selected project folder, if any. */
  projectPath: string | null
  /** The section it opens on; General by default. */
  initialSection?: SettingsSection
  projects: Project[]
  onUpdate(patch: SettingsPatch): Promise<void>
  onOpenFile(): Promise<string | null>
  onClose(): void
}

export function SettingsScreen({ state, projectPath, projects, onUpdate, onOpenFile, onClose, initialSection }: Props): React.JSX.Element {
  const [saveError, setSaveError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const pluginGuard = useRef<((leave: () => void) => void) | null>(null)
  const setPluginGuard = useCallback((guard: ((leave: () => void) => void) | null) => { pluginGuard.current = guard }, [])
  const navigate = useCallback((leave: () => void) => { if (pluginGuard.current) pluginGuard.current(leave); else leave() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) navigate(onClose)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, navigate])

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

  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'general')
  const [selectedProject, setSelectedProject] = useState(projectPath)
  const settingsProject = projects.find((p) => selectedProject !== null && sameFolder(p.path, selectedProject))
    ?? projects.find((p) => projectPath !== null && sameFolder(p.path, projectPath)) ?? projects[0]
  const settingsProjectPath = settingsProject?.path ?? null
  const projectFields = SETTING_FIELDS.filter((f) => f.scope === 'project' && !f.hidden)
  const globalFields = (appearance: boolean): React.JSX.Element[] =>
    SETTING_FIELDS.filter((f) => f.scope === 'global' && !f.hidden && APPEARANCE.has(f.key) === appearance).map((f) => (
      <Field
        key={f.key}
        field={f}
        value={state.global[f.key as keyof GlobalSettings]}
        onChange={(value) => void update({ global: { [f.key]: value } })}
      />
    ))
  const nav = (id: SettingsSection, icon: React.JSX.Element, label: string, path?: string): React.JSX.Element => (
    <button key={path ?? id} title={path} className={section === id && (!path || path === settingsProjectPath) ? 'settings-nav-item on' : 'settings-nav-item'}
      aria-current={section === id && (!path || path === settingsProjectPath) ? 'page' : undefined}
      onClick={() => navigate(() => { if (path) setSelectedProject(path); setSection(id) })}>
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <main className={`settings${section === 'plugins' ? ' settings-with-plugins' : ''}`}>
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        {nav('general', <SlidersVertical />, 'General')}
        {nav('appearance', <Palette />, 'Appearance')}
        {nav('mcp', <Server />, 'MCP servers')}
        {nav('agents', <Terminal />, 'Agents')}
        {nav('plugins', <Package />, 'Plugins')}
        {nav('phone', <Smartphone />, 'Phone')}
        {projectFields.length > 0 && (
          <>
            <div className="settings-nav-group">Projects</div>
            {projects.length ? projects.map((p) => nav('project', <Folder />, p.name || folderName(p.path), p.path))
              : nav('project', <Folder />, 'Projects')}
          </>
        )}
        <div className="settings-nav-group">Reference</div>
        {nav('shortcuts', <Keyboard />, 'Keyboard shortcuts')}
      </nav>
      <div className="settings-body">
        <div className="settings-file">
          {section !== 'plugins' && <><span className="mono" title={state.path}>
            {state.path}
          </span>
          <button className="ghost sm" onClick={() => void openFile()}>
            <ExternalLink />
            Open in editor
          </button>
          </>}
          <button className="secondary settings-close" onClick={() => navigate(onClose)} title="Close (Esc)">
            Done
          </button>
        </div>
        {openError && <p className="settings-problem">Couldn&apos;t open the file: {openError}</p>}
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

        {section === 'plugins' && <PluginSettings onManageConnections={() => setSection('mcp')} onNavigationGuard={setPluginGuard} />}

        {section === 'general' && (
          <section aria-labelledby="settings-general">
            <h2 id="settings-general">General</h2>
            <div className="settings-card">{globalFields(false)}</div>
          </section>
        )}
        {section === 'appearance' && (
          <section aria-labelledby="settings-appearance">
            <h2 id="settings-appearance">Appearance</h2>
            <div className="settings-card">{globalFields(true)}</div>
          </section>
        )}
        {section === 'mcp' && (
          <section aria-labelledby="settings-mcp">
            <h2 id="settings-mcp">MCP servers</h2>
            <McpSettings servers={state.global.mcpServers}
              hasLegacy={Object.values(state.projects).some((p) => (p.mcpServers?.length ?? 0) > 0)}
              onSave={async (mcpServers) => { await onUpdate({ global: { mcpServers } }) }} />
          </section>
        )}
        {section === 'agents' && (
          <section className="agents-settings" aria-labelledby="settings-agents">
            <h2 id="settings-agents">Agents</h2>
            <p className="lede">Claude Code and Codex are built in. Add other agents below.</p>
            <OpenCodeSettings executable={state.global.opencodeExecutable ?? ''}
              onSave={async (opencodeExecutable) => { await onUpdate({ global: { opencodeExecutable } }) }} />
            <AgentProfileSettings profiles={state.global.agentProfiles ?? []} defaultAgent={state.global.defaultAgent}
              onSave={async (agentProfiles, resetDefault) => { await onUpdate({ global: { agentProfiles, ...(resetDefault ? { defaultAgent: 'claude' } : {}) } }) }} />
          </section>
        )}
        {section === 'phone' && (
          <section aria-labelledby="settings-phone">
            <h2 id="settings-phone">Phone</h2>
            <PhoneSettings
              on={state.global.phoneAccess === true}
              port={state.global.phonePort ?? 8443}
              onUpdate={(values) => onUpdate({ global: values })}
            />
          </section>
        )}
        {section === 'project' && (
          <section aria-labelledby="settings-project">
            <h2 id="settings-project">{settingsProject?.name ?? 'Project'}</h2>
            {settingsProjectPath ? (
              <>
                <p className="lede mono" title={settingsProjectPath}>{settingsProjectPath}</p>
                <div className="settings-card">
                  {projectFields.map((f) => (
                    <Field key={`${settingsProjectPath}:${f.key}`} field={f}
                      value={projectSettings(state.projects, settingsProjectPath)[f.key as keyof ProjectSettings]}
                      onChange={(value) => void update({ project: { path: settingsProjectPath, values: { [f.key]: value } } })} />
                  ))}
                </div>
              </>
            ) : (
              <p className="lede">Open a project to configure its settings.</p>
            )}
          </section>
        )}
        {section === 'shortcuts' && (
          <section aria-labelledby="settings-shortcuts">
            <h2 id="settings-shortcuts">Keyboard shortcuts</h2>
            <Shortcuts />
          </section>
        )}
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
          <h3>{group.title}</h3>
          <dl className="settings-card">
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

/** A text setting, saved when it loses focus or on Enter, with suggestions. */
function TextSetting(props: { id: string; field: SettingField; value: string; onChange(value: string): void }): React.JSX.Element {
  const { id, field } = props
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const save = (): void => {
    if (draft !== props.value) props.onChange(draft)
  }
  return (
    <>
      <input
        id={id}
        className="setting-text"
        type="text"
        spellCheck={false}
        aria-describedby={`${id}-description`}
        placeholder={field.placeholder}
        list={field.suggestions ? `${id}-suggestions` : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setDraft(props.value)
        }}
      />
      {field.suggestions && (
        <datalist id={`${id}-suggestions`}>
          {field.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
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
      {field.key === 'externalEditor' ? (
        <EditorSetting id={id} value={typeof value === 'string' ? value : ''} onChange={props.onChange} />
      ) : field.type === 'shortcut' ? (
        <ShortcutSetting id={id} value={typeof value === 'string' ? value : ''} onChange={props.onChange} />
      ) : field.type === 'string' ? (
        <TextSetting id={id} field={field} value={typeof value === 'string' ? value : ''} onChange={props.onChange} />
      ) : field.type === 'enum' && SEGMENTED.has(field.key) ? (
        <Segmented
          id={id}
          ariaLabel={field.label}
          ariaDescribedBy={`${id}-description`}
          value={String(value)}
          options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
          onChange={props.onChange}
        />
      ) : field.type === 'enum' ? (
        <Select
          id={id}
          ariaLabel={field.label}
          ariaDescribedBy={`${id}-description`}
          value={String(value ?? field.options?.[0]?.value)}
          options={(field.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
          onChange={props.onChange}
        />
      ) : (
        <Switch id={id} ariaLabel={field.label} ariaDescribedBy={`${id}-description`} checked={value === true} onChange={props.onChange} />
      )}
    </div>
  )
}
