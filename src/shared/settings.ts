// Gloss's settings (SPEC → Settings): their types and one table describing each field.
// The main process validates the file and generates its JSON Schema from the table;
// the renderer builds the settings screen from it. Pure data, no Node or DOM imports.

import { sameFolder } from './paths'

export function projectSettings(projects: Record<string, ProjectSettings>, cwd: string): ProjectSettings {
  const key = Object.keys(projects).find((p) => sameFolder(p, cwd))
  return key ? projects[key] : {}
}

export type ThemeSetting = 'system' | 'light' | 'dark'

export type SessionOrder = 'created' | 'activity'

export type GlobalSettings = {
  defaultAgent: 'claude' | 'codex' | 'opencode'
  /** Empty or omitted discovers an installed native OpenCode executable. */
  opencodeExecutable?: string
  /** Light, dark, or whatever the system uses. */
  theme: ThemeSetting
  /** How the sidebar sorts a project's sessions. */
  sessionOrder: SessionOrder
  /** Show reply buttons on top-level numbered and bulleted list items. */
  listItemReplies: boolean
  /** Play a sound when a turn finishes in a session that isn't in front of the user. */
  turnEndSound: boolean
  /** The command that opens a file in the user's editor (`{file}`, `{line}`); empty for the system's default app. */
  externalEditor: string
  /** Tools made available to all agents in every project. */
  mcpServers: import('./mcp').McpServer[]
}

/** Settings for one project folder, under `projects` keyed by its path. */
export type ProjectSettings = {
  mcpServers?: import('./mcp').McpServer[]
  /** An existing Obsidian vault's name or ID; empty hides its shortcut. */
  obsidianVault?: string
}

export type SettingField = {
  key: string
  scope: 'global' | 'project'
  type: 'boolean' | 'enum' | 'string' | 'mcp'
  label: string
  description: string
  /** For enum fields: the allowed values and how the screen labels them. */
  options?: readonly { value: string; label: string }[]
  /** For string fields: shown when empty, and values the screen suggests. */
  placeholder?: string
  suggestions?: readonly string[]
  /** Set elsewhere in the window, so the settings screen doesn't list it. */
  hidden?: boolean
}

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'opencodeExecutable', scope: 'global', type: 'string', label: 'OpenCode executable',
    description: 'Path to the native OpenCode executable. Empty discovers an installed copy. Applied after current turns finish.',
    hidden: true
  },
  {
    key: 'obsidianVault', scope: 'project', type: 'string', label: 'Obsidian vault',
    description: 'The name or ID of an existing vault in Obsidian. Shows an Obsidian shortcut beside the project folder in the status line. Leave empty to hide it.',
    placeholder: 'Vault name or ID'
  },
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
    key: 'turnEndSound',
    scope: 'global',
    type: 'boolean',
    label: 'Sound when a turn finishes',
    description: "Play a chime when the agent finishes or fails, unless you're looking at that session. Not for turns you cancel."
  },
  {
    key: 'defaultAgent',
    scope: 'global',
    type: 'enum',
    label: 'Default agent',
    description: 'The agent new sessions use. Starred in the New session menu.',
    options: [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
      { value: 'opencode', label: 'OpenCode' }
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
  },
  {
    key: 'externalEditor',
    scope: 'global',
    type: 'string',
    label: 'External editor',
    description:
      "The command that opens a review's files in your editor. {file} and {line} are filled in; without {file} the path goes at the end. Empty opens the file with your system's default app.",
    placeholder: 'System default app',
    suggestions: ['code -g {file}:{line}', 'cursor -g {file}:{line}', 'zed {file}:{line}', 'subl {file}:{line}', 'notepad++ -n{line} {file}']
  }
]

export const SETTINGS_FILE = 'settings.json'
export const SCHEMA_FILE = 'settings.schema.json'
