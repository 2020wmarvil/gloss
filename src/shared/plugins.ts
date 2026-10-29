/** Phase 1: locally authored plugins. No native imports or marketplace state. */
export type PluginManifest = {
  schemaVersion: 1
  name: string
  description: string
  connections: string[]
  enabledAgents: string[]
}

export type PluginSkill = { id: string; name: string; description: string; path: string; files: string[] }
export type PluginAgentState = {
  id: string
  name: string
  enabled: boolean
  status: 'off' | 'ready' | 'setup' | 'error' | 'pending'
  support: 'tested' | 'configured' | 'unknown'
  message: string
  skillDirectory?: string
}
export type PersonalPlugin = PluginManifest & {
  id: string
  directory: string
  skills: PluginSkill[]
  problems: string[]
  agents: PluginAgentState[]
}
export type PluginLibraryState = {
  directory: string
  plugins: PersonalPlugin[]
  connections: { name: string; transport: 'stdio' | 'http' | 'sse'; usedBy: string[] }[]
  errors: string[]
}
export type PluginFile = { path: string; content: string; revision: string }
export type PluginChange = { name?: string; description?: string; connections?: string[] }
export type PluginApi = {
  list(): Promise<PluginLibraryState>
  create(name: string, description: string): Promise<string>
  update(id: string, change: PluginChange): Promise<void>
  remove(id: string): Promise<void>
  addSkill(id: string, name: string, description: string): Promise<string>
  removeSkill(id: string, skillId: string): Promise<void>
  readFile(id: string, path: string): Promise<PluginFile>
  writeFile(id: string, file: PluginFile): Promise<void>
  createFile(id: string, skillId: string, path: string, content: string): Promise<void>
  enable(id: string, agentId: string, enabled: boolean): Promise<void>
  setSkillDirectory(agentId: string, directory: string): Promise<void>
  refresh(agentId: string): Promise<void>
  openFolder(id?: string): Promise<void>
}

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export function pluginSlug(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'plugin'
}
