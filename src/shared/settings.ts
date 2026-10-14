// Gloss's settings (SPEC → Settings): their types and one table describing each field.
// The main process validates the file and generates its JSON Schema from the table;
// the renderer builds the settings screen from it. Pure data, no Node or DOM imports.

export type ThemeSetting = 'system' | 'light' | 'dark'

export type SessionOrder = 'created' | 'activity'

export type GlobalSettings = {
  defaultAgent: 'claude' | 'codex'
  /** Light, dark, or whatever the system uses. */
  theme: ThemeSetting
  /** How the sidebar sorts a project's sessions. */
  sessionOrder: SessionOrder
  /** Show reply buttons on top-level numbered and bulleted list items. */
  listItemReplies: boolean
  /** Tools made available to both agents in every project. */
  mcpServers: import('./mcp').McpServer[]
}

/** Settings for one project folder, under `projects` keyed by its path. */
export type ProjectSettings = { mcpServers?: import('./mcp').McpServer[] }

export type SettingField = {
  key: string
  scope: 'global' | 'project'
  type: 'boolean' | 'enum' | 'mcp'
  label: string
  description: string
  /** For enum fields: the allowed values and how the screen labels them. */
  options?: readonly { value: string; label: string }[]
  /** Set elsewhere in the window, so the settings screen doesn't list it. */
  hidden?: boolean
}

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'mcpServers', scope: 'global', type: 'mcp', label: 'MCP servers',
    description: 'Tools shared by agents in all projects. Applied on the next turn or resume.', hidden: true
  },
  {
    key: 'mcpServers', scope: 'project', type: 'mcp', label: 'MCP servers',
    description: 'Legacy project servers. Import into global MCP settings to use them.', hidden: true
  },
  {
    key: 'listItemReplies',
    scope: 'global',
    type: 'boolean',
    label: 'List item replies',
    description: 'Show reply buttons on numbered and bulleted list items. When off, select text to reply to it.'
  },
  {
    key: 'defaultAgent',
    scope: 'global',
    type: 'enum',
    label: 'Default agent',
    description: 'The agent new sessions use. Starred in the New session menu.',
    options: [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' }
    ],
    hidden: true
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
