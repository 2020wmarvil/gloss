import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentConfig } from './agents'
import type { McpServer } from '../shared/mcp'
import { mcpName } from '../shared/mcp'
import { PLUGIN_ID, pluginSlug, type PersonalPlugin, type PluginAgentState, type PluginChange, type PluginFile, type PluginLibraryState, type PluginManifest, type PluginSkill } from '../shared/plugins'

type Agent = { id: string; name: string }
type Deployment = { agentId: string; pluginId: string; target: string; source: string; mode: 'link' | 'copy'; hash: string }
type State = { schemaVersion: 1; customDirectories: Record<string, string>; deployments: Deployment[] }
type Options = {
  directory: string
  agents(): Agent[]
  connections(): McpServer[]
  busy?(agentId: string): boolean
  changed?(agentIds: string[]): void
  /** Test the copy fallback without depending on OS symlink privilege. */
  link?: typeof symlinkSync
}
const MAX_FILE = 1024 * 1024
const MAX_FILES = 1000
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Enter a valid ${label} (up to ${max} characters).`)
  return value.trim()
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length <= 256 && !v.includes('\0')) }
function atomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, file) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
function inside(root: string, file: string): boolean { const rel = relative(root, file); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
function exists(path: string): boolean { try { lstatSync(path); return true } catch (error) { if (isMissing(error)) return false; throw error } }

/** All source mutations are confined to this instance's library. Native user config is never edited. */
export class PluginLibrary {
  readonly directory: string
  private readonly runtime: string
  private readonly stateFile: string
  private state: State = { schemaVersion: 1, customDirectories: {}, deployments: [] }
  private readonly errors = new Map<string, string>()
  private readonly pending = new Set<string>()
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private fingerprint = ''
  private agentFingerprints = new Map<string, string>()
  private stateProblem: string | null = null

  constructor(private readonly options: Options) {
    const base = resolve(options.directory)
    this.directory = join(base, 'library')
    this.runtime = join(base, 'runtime')
    this.stateFile = join(base, 'state.json')
    mkdirSync(this.directory, { recursive: true })
    mkdirSync(this.runtime, { recursive: true })
    try {
      const state: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!object(state) || state.schemaVersion !== 1 || !object(state.customDirectories) || !Object.entries(state.customDirectories).every(([id, dir]) => id.startsWith('custom:') && typeof dir === 'string' && isAbsolute(dir)) || !Array.isArray(state.deployments) || !state.deployments.every(d => object(d) && typeof d.agentId === 'string' && typeof d.pluginId === 'string' && PLUGIN_ID.test(d.pluginId) && typeof d.target === 'string' && isAbsolute(d.target) && typeof d.source === 'string' && inside(join(this.directory, d.pluginId), d.source) && ['link', 'copy'].includes(String(d.mode)) && typeof d.hash === 'string')) throw new Error('Invalid plugin deployment state.')
      this.state = state as State
      for (const d of this.state.deployments) {
        const skillId = relative(join(this.directory, d.pluginId, 'skills'), d.source)
        if (!PLUGIN_ID.test(skillId) || resolve(d.target) !== resolve(this.target(d.agentId, d.pluginId, skillId))) throw new Error('Deployment paths do not match their plugin and agent.')
      }
    } catch (error) { if (!isMissing(error)) this.stateProblem = 'Plugin deployment state could not be read. Restore state.json before changing deployments.' }
    this.fingerprint = this.sourceFingerprint()
    this.agentFingerprints = this.signatures()
  }

  private id(id: unknown): string { if (typeof id !== 'string' || !PLUGIN_ID.test(id)) throw new Error('Invalid plugin identifier.'); return id }
  folder(id: string): string { return this.safe(join(this.directory, this.id(id))) }
  private safe(path: string): string {
    const absolute = resolve(path)
    if (!inside(this.directory, absolute)) throw new Error('Path must stay inside the plugin library.')
    let entry = this.directory
    if (lstatSync(entry).isSymbolicLink()) throw new Error('The plugin library must be a real directory.')
    for (const part of relative(this.directory, absolute).split(sep).filter(Boolean)) {
      entry = join(entry, part)
      if (exists(entry) && lstatSync(entry).isSymbolicLink()) throw new Error('Linked files in a plugin are not supported. Use ordinary files inside its folder.')
    }
    return absolute
  }
  private manifest(id: string): PluginManifest {
    const value: unknown = JSON.parse(readFileSync(this.safe(join(this.folder(id), 'plugin.json')), 'utf8'))
    if (!object(value) || value.schemaVersion !== 1 || typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string' || !strings(value.connections) || !strings(value.enabledAgents)) throw new Error('Invalid plugin.json. Expected schemaVersion, name, description, connections and enabledAgents.')
    if (Object.keys(value).some(k => !['schemaVersion', 'name', 'description', 'connections', 'enabledAgents'].includes(k))) throw new Error('This plugin manifest contains unsupported fields. Phase 1 supports skills and references to shared MCP connections.')
    return { schemaVersion: 1, name: value.name, description: value.description, connections: [...new Set(value.connections)], enabledAgents: [...new Set(value.enabledAgents)] }
  }
  private save(id: string, manifest: PluginManifest): void { atomic(this.safe(join(this.folder(id), 'plugin.json')), JSON.stringify(manifest, null, 2) + '\n') }
  private files(root: string): string[] {
    const result: string[] = []
    let bytes = 0
    const visit = (dir: string, depth: number): void => {
      if (depth > 12) throw new Error('Plugin folders are nested too deeply.')
      for (const item of readdirSync(this.safe(dir), { withFileTypes: true })) {
        const path = this.safe(join(dir, item.name))
        if (item.isDirectory()) visit(path, depth + 1)
        else if (item.isFile()) {
          bytes += lstatSync(path).size
          if (bytes > MAX_PLUGIN_BYTES) throw new Error('A plugin can contain at most 64 MB of files.')
          result.push(relative(root, path).split(sep).join('/'))
        }
        else throw new Error('Only ordinary files and directories are supported in plugins.')
        if (result.length > MAX_FILES) throw new Error(`A plugin can contain at most ${MAX_FILES} files.`)
      }
    }
    if (exists(root)) visit(root, 0)
    return result.sort()
  }
  private scanSkills(id: string): PluginSkill[] {
    const root = join(this.folder(id), 'skills')
    if (!exists(root)) return []
    return readdirSync(this.safe(root), { withFileTypes: true }).map(entry => {
      if (!entry.isDirectory() || !PLUGIN_ID.test(entry.name)) throw new Error('Each skill must be an ordinary folder with a lowercase name.')
      const dir = join(root, entry.name)
      const file = join(dir, 'SKILL.md')
      const raw = this.readText(file)
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
      const field = (key: string): string => {
        const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter?.[1] ?? '')?.[1]?.trim() ?? ''
        if (value.startsWith('"')) { try { return JSON.parse(value) } catch { return '' } }
        return value.replace(/^'(.*)'$/, '$1')
      }
      if (field('name') !== entry.name || !field('description') || ['>', '|'].includes(field('description'))) throw new Error(`${entry.name}: SKILL.md needs a matching name and a single-line description.`)
      return { id: entry.name, name: entry.name.startsWith(`${id}-`) ? entry.name.slice(id.length + 1) : entry.name, description: field('description'), path: `skills/${entry.name}/SKILL.md`, files: this.files(dir) }
    })
  }
  private readText(file: string): string {
    this.safe(file)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Only text files up to 1 MB can be opened here.')
    const content = readFileSync(file, 'utf8')
    if (content.includes('\0')) throw new Error('This file is binary. Open the plugin folder to inspect it.')
    return content
  }
  private sources(): { id: string; manifest: PluginManifest; skills: PluginSkill[]; problems: string[] }[] {
    return readdirSync(this.directory, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).map(d => {
      const id = d.name
      let manifest: PluginManifest = { schemaVersion: 1, name: id, description: '', connections: [], enabledAgents: [] }
      let skills: PluginSkill[] = []
      const problems: string[] = []
      try {
        this.id(id); manifest = this.manifest(id)
        this.files(this.folder(id))
        if (['hooks', 'agents', 'commands', '.mcp.json', 'mcp.json', 'index.js', 'index.ts', '.claude-plugin'].some(name => exists(join(this.folder(id), name)))) throw new Error('Native hooks, agents, commands and embedded servers are not loaded in phase 1. Use skills and shared MCP connection references.')
        skills = this.scanSkills(id)
      } catch (error) { problems.push(message(error)) }
      return { id, manifest, skills, problems }
    })
  }
  private blockers(manifest: PluginManifest, agentId: string): string[] {
    const connections = this.options.connections()
    return manifest.connections.flatMap(name => {
      const server = connections.find(s => mcpName(s.name) === mcpName(name))
      if (!server) return [`Configure the ${name} connection in MCP servers.`]
      if ('type' in server && (agentId === 'codex' && server.type === 'sse' || agentId.startsWith('custom:') && server.type !== undefined)) return [`${name}: ${server.type.toUpperCase()} MCP support is not verified for this agent.`]
      return []
    })
  }
  list(): PluginLibraryState {
    const sources = this.sources()
    const agents = this.options.agents()
    const deploymentErrors = this.deploymentErrors()
    const plugins: PersonalPlugin[] = sources.map(p => ({ ...p.manifest, id: p.id, directory: join(this.directory, p.id), skills: p.skills, problems: p.problems,
      agents: agents.map(agent => {
        const enabled = p.manifest.enabledAgents.includes(agent.id)
        const custom = agent.id.startsWith('custom:')
        const configured = !custom || !!this.state.customDirectories[agent.id]
        const issues = [...p.problems, ...this.blockers(p.manifest, agent.id)]
        const deploymentError = deploymentErrors.get(`${agent.id}:${p.id}`)
        const status: PluginAgentState['status'] = deploymentError ? 'error' : issues.length || !configured ? 'setup' : this.pending.has(agent.id) ? 'pending' : !enabled ? 'off' : 'ready'
        return { ...agent, enabled, status, support: custom ? configured ? 'configured' : 'unknown' : 'tested', skillDirectory: this.state.customDirectories[agent.id],
          delivery: agent.id === 'claude' ? 'Local Claude plugin' : agent.id === 'codex' ? 'Scoped skills and shared MCP' : agent.id === 'opencode' ? 'Configured skills and shared MCP' : 'Configured skill directory; stdio MCP',
          message: deploymentError ?? issues[0] ?? (!configured ? 'Configure a skill directory for this custom agent.' : status === 'pending' ? 'The selected availability will apply when the active turn finishes.' : enabled ? 'Skill files are available. Existing conversation instructions are retained; connection authentication is checked by the agent.' : 'Not enabled for this agent.') }
      }) }))
    return { directory: this.directory, plugins, connections: this.options.connections().map(s => ({ name: s.name, transport: 'type' in s ? s.type : 'stdio', usedBy: plugins.filter(p => p.connections.some(n => mcpName(n) === mcpName(s.name))).map(p => p.name) })), errors: this.stateProblem ? [this.stateProblem] : [] }
  }

  create(name: string, description: string): string {
    name = text(name, 'plugin name', 80)
    if (typeof description !== 'string' || description.length > 1000) throw new Error('Description must be at most 1000 characters.')
    if (this.sources().some(p => p.manifest.name.toLowerCase() === name.toLowerCase())) throw new Error('A plugin with this name already exists.')
    let id = pluginSlug(name)
    if (exists(join(this.directory, id))) id = `${id}-${randomUUID().slice(0, 6)}`
    mkdirSync(this.folder(id))
    try {
      this.save(id, { schemaVersion: 1, name, description, connections: [], enabledAgents: [] })
      this.addSkill(id, 'instructions', description || `Instructions for ${name}.`)
    } catch (error) { rmSync(this.folder(id), { recursive: true }); throw error }
    return id
  }
  update(id: string, change: PluginChange): void {
    if (!object(change) || Object.keys(change).some(k => !['name', 'description', 'connections'].includes(k))) throw new Error('Invalid plugin changes.')
    const manifest = this.manifest(id)
    if (change.name !== undefined) {
      const name = text(change.name, 'plugin name', 80)
      if (this.sources().some(p => p.id !== id && p.manifest.name.toLowerCase() === name.toLowerCase())) throw new Error('A plugin with this name already exists.')
      manifest.name = name
    }
    if (change.description !== undefined) {
      if (typeof change.description !== 'string' || change.description.length > 1000) throw new Error('Description must be at most 1000 characters.')
      manifest.description = change.description
    }
    if (change.connections !== undefined) {
      if (!strings(change.connections)) throw new Error('Invalid connection references.')
      manifest.connections = [...new Set(change.connections)]
    }
    this.save(id, manifest); this.changed()
  }
  addSkill(id: string, name: string, description: string): string {
    this.manifest(id)
    name = text(name, 'skill name', 48)
    description = text(description, 'skill description', 1000)
    const skillId = `${id}-${pluginSlug(name)}`
    if (!PLUGIN_ID.test(skillId)) throw new Error('The plugin and skill names together must fit within 64 characters.')
    const folder = this.safe(join(this.folder(id), 'skills', skillId))
    if (exists(folder)) throw new Error('A skill with this name already exists in this plugin.')
    mkdirSync(folder, { recursive: true })
    atomic(join(folder, 'SKILL.md'), `---\nname: ${skillId}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\nDescribe the workflow here.\n`)
    this.changed(); return skillId
  }
  private file(id: string, path: string): string {
    if (typeof path !== 'string' || !path.startsWith('skills/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Choose a relative file path within a skill.')
    return this.safe(join(this.folder(id), path))
  }
  readFile(id: string, path: string): PluginFile { const content = this.readText(this.file(id, path)); return { path, content, revision: hash(content) } }
  writeFile(id: string, file: PluginFile): void {
    if (!object(file) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > MAX_FILE || file.content.includes('\0')) throw new Error('Use text content up to 1 MB.')
    const existing = this.readFile(id, file.path)
    if (existing.revision !== file.revision) throw new Error('This file changed outside the editor. Reload it before saving to preserve those edits.')
    atomic(this.file(id, file.path), file.content); this.changed()
  }
  createFile(id: string, skillId: string, path: string, content: string): void {
    this.id(skillId)
    if (!this.scanSkills(id).some(s => s.id === skillId)) throw new Error('Unknown skill.')
    const file = this.file(id, `skills/${skillId}/${path}`)
    if (exists(file)) throw new Error('This file already exists.')
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE || content.includes('\0')) throw new Error('Use text content up to 1 MB.')
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, { flag: 'wx' }); this.changed()
  }
  removeSkill(id: string, skillId: string): void {
    this.id(skillId); const manifest = this.manifest(id)
    if (manifest.enabledAgents.length) throw new Error('Turn this plugin off for its agents before removing a skill.')
    if (this.state.deployments.some(d => d.pluginId === id && this.options.busy?.(d.agentId))) throw new Error('Wait for this plugin’s active turns to finish before removing a skill.')
    const skill = this.scanSkills(id).find(s => s.id === skillId)
    if (!skill) throw new Error('Unknown skill.')
    rmSync(this.safe(join(this.folder(id), 'skills', skillId)), { recursive: true }); this.changed()
  }
  remove(id: string): void {
    this.assertState()
    const folder = this.folder(id)
    const targets = this.state.deployments.filter(d => inside(folder, d.source))
    if (targets.some(d => this.options.busy?.(d.agentId))) throw new Error('Wait for the agents using this plugin to finish their turns before removing it.')
    for (const target of targets) this.assertOwned(target)
    for (const target of targets) this.removeTarget(target)
    rmSync(folder, { recursive: true }); this.changed()
  }
  enable(id: string, agentId: string, enabled: boolean): void {
    this.assertState()
    if (typeof enabled !== 'boolean' || !this.options.agents().some(a => a.id === agentId)) throw new Error('Unknown agent or invalid availability.')
    const manifest = this.manifest(id)
    const plugin = this.list().plugins.find(p => p.id === id)!
    if (enabled && (plugin.problems.length || this.blockers(manifest, agentId).length)) throw new Error(plugin.problems[0] ?? this.blockers(manifest, agentId)[0])
    if (enabled && agentId.startsWith('custom:') && !this.state.customDirectories[agentId]) throw new Error('Configure this agent’s skill directory first.')
    const next = { ...manifest, enabledAgents: enabled ? [...new Set([...manifest.enabledAgents, agentId])] : manifest.enabledAgents.filter(a => a !== agentId) }
    this.save(id, next)
    try { this.reconcile(); const error = this.errors.get(`${agentId}:${id}`); if (error) throw new Error(error) }
    catch (error) { this.save(id, manifest); this.reconcile(); throw error }
    this.changed()
  }
  setSkillDirectory(agentId: string, directory: string): void {
    this.assertState()
    if (!agentId.startsWith('custom:') || !this.options.agents().some(a => a.id === agentId)) throw new Error('Choose a configured custom agent.')
    if (this.sources().some(p => p.manifest.enabledAgents.includes(agentId))) throw new Error('Turn off plugins for this agent before changing its skill directory.')
    if (this.options.busy?.(agentId)) throw new Error('Wait for this agent to finish its turn before changing the skill directory.')
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new Error('Enter an absolute skill-directory path.')
    const target = resolve(directory)
    if (inside(this.directory, target) || inside(target, this.directory)) throw new Error('The agent directory must be separate from the shared library.')
    const sharedRoots = ['.agents/skills', '.claude/skills', '.codex/skills', '.config/opencode/skills'].map(p => join(homedir(), p))
    if (sharedRoots.some(root => inside(root, target) || inside(target, root))) throw new Error('Use this custom agent’s own skill directory, separate from other agents’ discovery roots.')
    if (Object.entries(this.state.customDirectories).some(([id, dir]) => id !== agentId && resolve(dir).toLowerCase() === target.toLowerCase())) throw new Error('Each custom agent needs its own skill directory for independent availability.')
    mkdirSync(target, { recursive: true })
    const canonical = realpathSync(target)
    if (sharedRoots.some(root => inside(root, canonical) || inside(canonical, root)) || inside(this.directory, canonical) || inside(canonical, this.directory)) throw new Error('Use a directory separate from the library and other agents’ discovery roots.')
    this.state.customDirectories[agentId] = canonical; this.persist(); this.changed()
  }

  private assertState(): void { if (this.stateProblem) throw new Error(this.stateProblem) }
  private persist(): void { this.assertState(); atomic(this.stateFile, JSON.stringify(this.state, null, 2) + '\n') }
  private contentHash(root: string): string {
    const entries: string[] = []
    let bytes = 0
    const walk = (dir: string, depth = 0): void => {
      if (depth > 12 || entries.length > MAX_FILES * 2) throw new Error('Deployment contains too many files or directory levels.')
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, item.name)
        if (item.isSymbolicLink()) throw new Error('A deployment contains an unexpected link.')
        if (item.isDirectory()) walk(path, depth + 1)
        else {
          bytes += lstatSync(path).size
          if (bytes > MAX_PLUGIN_BYTES) throw new Error('Deployment exceeds 64 MB.')
          entries.push(relative(root, path), hash(readFileSync(path)))
        }
      }
    }
    walk(root); return hash(entries.join('\n'))
  }
  private assertOwned(d: Deployment): void {
    this.assertTargetParents(d.agentId, dirname(d.target))
    if (!exists(d.target)) return
    const stat = lstatSync(d.target)
    if (d.mode === 'link') {
      if (!stat.isSymbolicLink()) throw new Error(`Deployment was replaced outside Gloss: ${d.target}. Its files were preserved.`)
      const target = resolve(dirname(d.target), readlinkSync(d.target)).replace(/^\\\\\?\\/, '')
      const source = resolve(d.source).replace(/^\\\\\?\\/, '')
      if ((process.platform === 'win32' ? target.toLowerCase() !== source.toLowerCase() : target !== source)) throw new Error(`Deployment points elsewhere: ${d.target}. It was preserved.`)
    } else if (!stat.isDirectory() || stat.isSymbolicLink() || this.contentHash(d.target) !== d.hash) throw new Error(`Deployment has local edits: ${d.target}. Preserve or reconcile those edits before retrying.`)
  }
  private removeTarget(d: Deployment): void {
    this.assertOwned(d)
    if (exists(d.target)) {
      if (d.mode === 'link') unlinkSync(d.target)
      else rmSync(d.target, { recursive: true })
    }
    this.state.deployments = this.state.deployments.filter(x => x.target !== d.target); this.persist()
  }
  private deploymentErrors(): Map<string, string> {
    const errors = new Map(this.errors)
    for (const d of this.state.deployments) {
      try {
        if (!exists(d.target)) throw new Error(`A managed deployment is missing: ${d.target}. Refresh this agent to restore it.`)
        this.assertOwned(d)
      } catch (error) { errors.set(`${d.agentId}:${d.pluginId}`, message(error)) }
    }
    return errors
  }
  private deploy(source: string, target: string, agentId: string, pluginId: string): void {
    this.safe(source)
    this.assertTargetParents(agentId, dirname(target))
    const recorded = this.state.deployments.find(d => d.target === target)
    if (recorded) this.assertOwned(recorded)
    else if (exists(target)) throw new Error(`An existing folder occupies ${target}. Gloss will not replace it.`)
    if (recorded && exists(target) && recorded.source === source && recorded.mode === 'link') return
    const digest = this.contentHash(source)
    if (recorded && exists(target) && recorded.mode === 'copy' && recorded.hash === digest) return
    mkdirSync(dirname(target), { recursive: true })
    const staged = `${target}.gloss-${randomUUID()}`
    let mode: Deployment['mode'] = 'link'
    try {
      try { (this.options.link ?? symlinkSync)(source, staged, process.platform === 'win32' ? 'junction' : 'dir') }
      catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        mode = 'copy'; cpSync(source, staged, { recursive: true, errorOnExist: true, force: false })
      }
      if (recorded) this.removeTarget(recorded)
      renameSync(staged, target)
      this.state.deployments.push({ agentId, pluginId, target, source, mode, hash: digest }); this.persist()
    } finally {
      if (exists(staged)) { if (lstatSync(staged).isSymbolicLink()) unlinkSync(staged); else rmSync(staged, { recursive: true }) }
    }
  }
  private target(agentId: string, pluginId: string, skillId: string): string {
    if (agentId === 'claude') return join(this.runtime, 'claude', pluginId, 'skills', skillId)
    if (agentId === 'codex') return join(this.runtime, 'codex', '.agents', 'skills', skillId)
    if (agentId === 'opencode') return join(this.runtime, 'opencode', 'skills', skillId)
    const dir = this.state.customDirectories[agentId]
    if (!dir) throw new Error('Configure the custom agent’s skill directory.')
    return join(dir, `gloss-${skillId}`)
  }
  private assertTargetParents(agentId: string, target: string): void {
    const root = agentId.startsWith('custom:') ? this.state.customDirectories[agentId] : this.runtime
    if (!root || !inside(root, target)) throw new Error('Invalid deployment root.')
    if (exists(root) && (lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== resolve(root).toLowerCase())) throw new Error('The deployment directory was redirected outside Gloss. Restore its original location before retrying.')
    let dir = root
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      dir = join(dir, part)
      if (exists(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('A deployment parent was replaced by a link. Its contents were preserved.')
    }
  }
  reconcile(): void {
    if (this.stateProblem) return
    this.errors.clear()
    const expected = new Set<string>()
    for (const d of this.state.deployments) if (this.options.busy?.(d.agentId)) expected.add(d.target)
    for (const p of this.sources()) for (const agent of this.options.agents()) {
      if (this.options.busy?.(agent.id)) continue
      if (!p.manifest.enabledAgents.includes(agent.id) || p.problems.length || this.blockers(p.manifest, agent.id).length) continue
      try {
        const plans = p.skills.map(s => ({ source: join(this.folder(p.id), 'skills', s.id), target: this.target(agent.id, p.id, s.id) }))
        for (const plan of plans) {
          expected.add(plan.target)
          const record = this.state.deployments.find(d => d.target === plan.target)
          if (record) {
            if (record.source !== plan.source) throw new Error(`Another plugin already uses the skill name ${relative(dirname(plan.target), plan.target)}. Rename this skill before enabling it.`)
            this.assertOwned(record)
          }
          else if (exists(plan.target)) throw new Error(`Existing content at ${plan.target} was preserved. Choose another skill name or directory.`)
        }
        for (const plan of plans) this.deploy(plan.source, plan.target, agent.id, p.id)
        if (agent.id === 'claude') {
          const parent = join(this.runtime, 'claude', p.id, '.claude-plugin')
          this.assertTargetParents(agent.id, parent)
          const file = join(parent, 'plugin.json')
          const content = JSON.stringify({ name: `gloss-${p.id}`, description: p.manifest.description }) + '\n'
          if (!exists(file) || lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== content) atomic(file, content)
        }
      } catch (error) { this.errors.set(`${agent.id}:${p.id}`, message(error)) }
    }
    for (const d of [...this.state.deployments]) if (!expected.has(d.target)) {
      try { this.removeTarget(d) } catch (error) {
        const pluginId = relative(this.directory, d.source).split(sep)[0]
        for (const agent of this.options.agents()) this.errors.set(`${agent.id}:${pluginId}`, message(error))
      }
    }
  }
  /** Decorates only Gloss's process/session configuration, never native user settings. */
  configureAgent(config: AgentConfig): AgentConfig {
    if (this.stateProblem) throw new Error(this.stateProblem)
    const deploymentError = [...this.deploymentErrors()].find(([key]) => key.startsWith(`${config.id}:`))?.[1]
    if (deploymentError) throw new Error(`Resolve the plugin deployment problem before starting this agent: ${deploymentError}`)
    const enabled = this.sources().filter(p => p.manifest.enabledAgents.includes(config.id) && !p.problems.length && !this.blockers(p.manifest, config.id).length && !this.errors.has(`${config.id}:${p.id}`))
    if (config.id === 'opencode') {
      const raw = config.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}'
      const content: unknown = JSON.parse(raw)
      if (!object(content) || content.skills !== undefined && !strings(content.skills)) throw new Error('OpenCode skills configuration must be an array of paths.')
      return { ...config, env: { ...config.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, skills: [...new Set([...(content.skills as string[] ?? []), ...(enabled.length ? [join(this.runtime, 'opencode', 'skills')] : [])])] }) } }
    }
    if (config.id !== 'claude' && config.id !== 'codex') return config
    return { ...config, sessionMeta: instructions => {
      const meta = config.sessionMeta?.(instructions) ?? {}
      return Object.fromEntries((['new', 'load'] as const).map(kind => {
        const previous = meta[kind] ?? {}
        if (config.id === 'codex') return [kind, { ...previous, additionalRoots: [...(Array.isArray(previous.additionalRoots) ? previous.additionalRoots : []), ...(enabled.length ? [join(this.runtime, 'codex')] : [])] }]
        const claude = object(previous.claudeCode) ? previous.claudeCode : {}
        const options = object(claude.options) ? claude.options : {}
        return [kind, { ...previous, claudeCode: { ...claude, options: { ...options, plugins: [...(Array.isArray(options.plugins) ? options.plugins : []), ...enabled.map(p => ({ type: 'local', path: join(this.runtime, 'claude', p.id) }))] } } }]
      }))
    } }
  }
  markPending(agentIds: string[]): void { for (const id of agentIds) this.pending.add(id) }
  refreshed(agentId: string): void { this.pending.delete(agentId) }
  private sourceFingerprint(): string {
    try { return hash(readdirSync(this.directory).sort().map(id => {
      try { return id + ':' + this.files(this.folder(id)).map(path => `${path}:${hash(readFileSync(this.safe(join(this.folder(id), path))))}`).join('\n') }
      catch (error) { return id + ':' + message(error) }
    }).join('\n')) }
    catch (error) { return hash(message(error)) }
  }
  private signatures(): Map<string, string> {
    const sources = this.sources()
    return new Map(this.options.agents().map(agent => [agent.id, hash(JSON.stringify(sources.filter(p => p.manifest.enabledAgents.includes(agent.id)).map(p => {
      let content: string
      try { content = this.contentHash(this.folder(p.id)) } catch (error) { content = message(error) }
      return { id: p.id, content, directory: this.state.customDirectories[agent.id], connections: this.options.connections().filter(s => p.manifest.connections.some(n => mcpName(n) === mcpName(s.name))) }
    })))]))
  }
  private changed(): void {
    this.reconcile(); this.fingerprint = this.sourceFingerprint()
    const next = this.signatures()
    const changed = [...new Set([...this.agentFingerprints.keys(), ...next.keys()])].filter(id => this.agentFingerprints.get(id) !== next.get(id))
    this.agentFingerprints = next
    this.options.changed?.(changed)
  }
  settingsChanged(): void { this.changed() }
  startWatching(): void {
    this.reconcile()
    this.watcher = watch(this.directory, { recursive: true }, () => {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        const next = this.sourceFingerprint()
        if (next !== this.fingerprint) this.changed()
      }, 350)
    })
  }
  close(): void { clearTimeout(this.timer); this.watcher?.close() }
}
