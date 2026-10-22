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

/**
 * The permission mode new sessions start in (SPEC → Permission modes). `bypass`: the
 * agent's bypass mode, or Gloss's auto-approval for an agent without one. `agent`: the
 * agent's own default mode, which asks before acting where the agent does.
 */
export type PermissionModeSetting = 'bypass' | 'agent'

export const DEFAULT_EXTERNAL_EDITOR = 'code -g {file}:{line}'

/** Commands use each editor's CLI launcher, which must be installed on PATH. */
export const EDITOR_PRESETS = [
  { label: 'Visual Studio Code', value: DEFAULT_EXTERNAL_EDITOR },
  { label: 'VS Code Insiders', value: 'code-insiders -g {file}:{line}' },
  { label: 'Cursor', value: 'cursor -g {file}:{line}' },
  { label: 'Windsurf', value: 'windsurf -g {file}:{line}' },
  { label: 'VSCodium', value: 'codium -g {file}:{line}' },
  { label: 'Zed', value: 'zed {file}:{line}' },
  { label: 'Sublime Text', value: 'subl {file}:{line}' },
  { label: 'Notepad++', value: 'notepad++ -n{line} {file}' },
  { label: 'Notepad', value: 'notepad {file}' },
  { label: 'Kate', value: 'kate --line {line} {file}' },
  { label: 'System default app', value: '' }
] as const

export type GlobalSettings = {
  defaultAgent: string
  agentProfiles?: import('./agentProfiles').AgentProfile[]
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
  /** The permission mode new sessions start in. */
  permissionMode: PermissionModeSetting
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
  /** Overrides the global permission mode for new sessions here; `inherit` (or omitted) uses it. */
  permissionMode?: PermissionModeSetting | 'inherit'
}

export type SettingField = {
  key: string
  scope: 'global' | 'project'
  type: 'boolean' | 'enum' | 'string' | 'mcp' | 'profiles' | 'agent'
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
    key: 'agentProfiles', scope: 'global', type: 'profiles', label: 'Custom ACP agents',
    description: 'Launch settings for custom ACP agents.', hidden: true
  },
  {
    key: 'opencodeExecutable', scope: 'global', type: 'string', label: 'OpenCode executable',
    description: 'Native executable path. Empty finds an installed copy.',
    hidden: true
  },
  {
    key: 'obsidianVault', scope: 'project', type: 'string', label: 'Obsidian vault',
    description: 'Vault name or ID. Empty hides its shortcut.',
    placeholder: 'Vault name or ID'
  },
  {
    key: 'mcpServers', scope: 'global', type: 'mcp', label: 'MCP servers',
    description: 'Shared tools. Applied next turn or resume.', hidden: true
  },
  {
    key: 'mcpServers', scope: 'project', type: 'mcp', label: 'MCP servers',
    description: 'Import legacy servers into global MCP settings.', hidden: true
  },
  {
    key: 'permissionMode',
    scope: 'global',
    type: 'enum',
    label: 'Permission mode',
    description: "How new sessions start. Bypass runs tools without asking; the agent's default asks first. Change it per session in the status line.",
    options: [
      { value: 'bypass', label: 'Bypass permissions' },
      { value: 'agent', label: "Agent's default" }
    ]
  },
  {
    key: 'permissionMode',
    scope: 'project',
    type: 'enum',
    label: 'Permission mode',
    description: 'How new sessions in this project start.',
    options: [
      { value: 'inherit', label: 'Same as global' },
      { value: 'bypass', label: 'Bypass permissions' },
      { value: 'agent', label: "Agent's default" }
    ]
  },
  {
    key: 'listItemReplies',
    scope: 'global',
    type: 'boolean',
    label: 'List item replies',
    description: 'Show Reply on list items.'
  },
  {
    key: 'turnEndSound',
    scope: 'global',
    type: 'boolean',
    label: 'Sound when a turn finishes',
    description: 'Chime for background completions and failures.'
  },
  {
    key: 'defaultAgent',
    scope: 'global',
    type: 'agent',
    label: 'Default agent',
    description: 'Star an agent in the New session menu.',
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
    description: 'System follows your device theme.',
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
      "Sort by creation time or recent activity.",
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
      'Open file links and review files in your editor. Custom commands replace {file} with the path and {line} with the line number. Use a command on PATH or a full executable path.',
    placeholder: DEFAULT_EXTERNAL_EDITOR,
  }
]

export const SETTINGS_FILE = 'settings.json'
export const SCHEMA_FILE = 'settings.schema.json'
