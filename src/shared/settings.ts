// Gloss's settings (SPEC → Settings): their types and one table describing each field.
// The main process validates the file and generates its JSON Schema from the table;
// the renderer builds the settings screen from it. Pure data, no Node or DOM imports.

export type ThemeSetting = 'system' | 'light' | 'dark'

export type SessionOrder = 'created' | 'activity'

export type GlobalSettings = {
  defaultAgent: 'claude' | 'codex'
  /** Spawn Claude Code with ANTHROPIC_MODEL=haiku so development prompts are cheap. */
  devModel: boolean
  /** Light, dark, or whatever the system uses. */
  theme: ThemeSetting
  /** How the sidebar sorts a project's sessions. */
  sessionOrder: SessionOrder
}

/** Settings for one project folder, under `projects` keyed by its path. None exist yet (M7+). */
export type ProjectSettings = Record<string, never>

export type SettingField = {
  key: string
  scope: 'global' | 'project'
  type: 'boolean' | 'enum'
  label: string
  description: string
  /** For enum fields: the allowed values and how the screen labels them. */
  options?: readonly { value: string; label: string }[]
}

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'defaultAgent',
    scope: 'global',
    type: 'enum',
    label: 'Default agent',
    description: 'The agent selected for new sessions.',
    options: [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' }
    ]
  },
  {
    key: 'devModel',
    scope: 'global',
    type: 'boolean',
    label: 'Dev model (Haiku)',
    description:
      'Spawn Claude Code with ANTHROPIC_MODEL=haiku so development prompts are cheap. Changing it restarts running agents.'
  },
  {
    key: 'theme',
    scope: 'global',
    type: 'enum',
    label: 'Theme',
    description: 'Light or dark. System follows the operating system setting.',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' }
    ]
  },
  {
    key: 'sessionOrder',
    scope: 'global',
    type: 'enum',
    label: 'Session order',
    description:
      "How the sidebar sorts a project's sessions. The agent doesn't say when a session started outside Gloss began, so until it is opened here it counts from its last activity.",
    options: [
      { value: 'created', label: 'Newest first' },
      { value: 'activity', label: 'Recent activity' }
    ]
  }
]

export const SETTINGS_FILE = 'settings.json'
export const SCHEMA_FILE = 'settings.schema.json'
