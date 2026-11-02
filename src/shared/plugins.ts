/** Phase 1: locally authored plugins. No native imports or marketplace state. */
export type PluginManifest = {
  schemaVersion: 1
  name: string
  description: string
  connections: string[]
  enabledAgents: string[]
}

export type SkillInvocation = 'automatic' | 'direct'
export type PluginSkill = { id: string; name: string; description: string; path: string; files: string[]; invocation: SkillInvocation | 'mixed' }
export type PluginAgentState = {
  id: string
  name: string
  enabled: boolean
  status: 'off' | 'ready' | 'setup' | 'error' | 'pending'
  support: 'tested' | 'configured' | 'unknown'
  message: string
  skillDirectory?: string
}
/** `agents/<id>.md` (SPEC → Plugins → Subagents and hooks). `models` is per agent id. */
export type PluginSubagent = { id: string; description: string; tools: 'read-only' | 'inherit'; models: Partial<Record<string, string>>; path: string }
/** One entry of `hooks/hooks.json`. `event` is Gloss's or, with `agents`, an agent's own; `timeout` in seconds. */
export type PluginHook = { event: string; matcher?: string; command: string; timeout: number; agents?: string[] }
export type PersonalPlugin = PluginManifest & {
  id: string
  directory: string
  skills: PluginSkill[]
  subagents: PluginSubagent[]
  hooks: PluginHook[]
  problems: string[]
  agents: PluginAgentState[]
  /** Gloss's own read-only, always-on plugin (SPEC → Plugins → Import). */
  builtin?: boolean
}
/** The built-in plugin's id: outside PLUGIN_ID, so no library operation accepts it. */
export const BUILTIN_PLUGIN_ID = 'gloss:builtin'
export type PluginLibraryState = {
  directory: string
  plugins: PersonalPlugin[]
  connections: { name: string; transport: 'stdio' | 'http' | 'sse'; usedBy: string[] }[]
  errors: string[]
}
export type PluginFile = { path: string; content: string; revision: string }
export type PluginApi = {
  list(): Promise<PluginLibraryState>
  readFile(id: string, path: string): Promise<PluginFile>
  enable(id: string, agentId: string, enabled: boolean): Promise<void>
  setSkillDirectory(agentId: string, directory: string): Promise<void>
  refresh(agentId: string): Promise<void>
  openInEditor(id: string, path: string): Promise<void>
  openFolder(id?: string): Promise<void>
}

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
