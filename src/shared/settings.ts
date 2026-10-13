// Gloss's settings (SPEC → Settings): their types and one table describing each field.
// The main process validates the file and generates its JSON Schema from the table;
// the renderer builds the settings screen from it. Pure data, no Node or DOM imports.

export type GlobalSettings = {
  /** Spawn agents with ANTHROPIC_MODEL=haiku so development prompts are cheap. */
  devModel: boolean
}

/** Settings for one project folder, under `projects` keyed by its path. None exist yet (M7+). */
export type ProjectSettings = Record<string, never>

export type SettingField = {
  key: string
  scope: 'global' | 'project'
  type: 'boolean'
  label: string
  description: string
}

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'devModel',
    scope: 'global',
    type: 'boolean',
    label: 'Dev model (Haiku)',
    description:
      'Spawn agents with ANTHROPIC_MODEL=haiku so development prompts are cheap. Changing it restarts running agents.'
  }
]

export const SETTINGS_FILE = 'settings.json'
export const SCHEMA_FILE = 'settings.schema.json'
