import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentConfig } from './agents'
import type { McpServer } from '../shared/mcp'
import { skillInvocation } from './skillInvocation'
import { BUILTIN_SKILLS, LEGACY_BUILTIN_SKILLS, type BuiltinSkill } from './pluginSkill'
import { mcpName } from '../shared/mcp'
import { OPENCODE_HOOK_PLUGIN, claudeSubagent, codexRole, flatName, isPartAgent, nativeHooks, openCodeHooks, openCodeSubagent, parseHooks, parseSubagent, planHook, type PartAgent } from './pluginParts'
import { BUILTIN_PLUGIN_ID, PLUGIN_ID, type PersonalPlugin, type PluginAgentState, type PluginFile, type PluginLibraryState, type PluginHook, type PluginManifest, type PluginSkill, type PluginSubagent } from '../shared/plugins'

type Agent = { id: string; name: string }
type Deployment = { agentId: string; pluginId: string; target: string; source: string; mode: 'link' | 'copy'; hash: string }
/** `codexHookTrust`: the hash Codex reported for each hook Gloss gave it (its key → hash), passed back as trusted. */
type State = { schemaVersion: 1; customDirectories: Record<string, string>; deployments: Deployment[]; codexHookTrust?: Record<string, string> }
type Subagent = PluginSubagent & { instructions: string }
/** One of Codex's hooks, as `_codex/hooks/list` reports it. */
export type CodexHook = { key: string; currentHash: string; trustStatus: string; source?: string }
type Options = {
  directory: string
  agents(): Agent[]
  connections(): McpServer[]
  busy?(agentId: string): boolean
  changed?(agentIds: string[]): void
  /** Gloss's settings.json, named in the built-in skill. Without it there is no built-in skill. */
  settings?: string
  /** Test the copy fallback without depending on OS symlink privilege. */
  link?: typeof symlinkSync
}
const MANIFEST_KEYS = ['schemaVersion', 'name', 'description', 'connections', 'enabledAgents']
/** Native plugin parts Gloss doesn't deliver (SPEC → Plugins): a plugin with one shows a problem instead. */
const NATIVE_PARTS = ['commands', '.mcp.json', 'mcp.json', 'index.js', 'index.ts', '.claude-plugin']
const MAX_FILE = 1024 * 1024
const MAX_FILES = 1000
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length <= 256 && !v.includes('\0')) }
function atomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, file) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
function inside(root: string, file: string): boolean { const rel = relative(root, file); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
/**
 * A skill's name outside Claude, which has no plugin namespace for it: `<plugin-id>-<skill>`. Claude shows
 * `<plugin-id>:<skill>`. A skill whose folder already starts with the plugin id (the earlier naming) keeps it.
 */
export function flatSkillName(pluginId: string, skillId: string): string { return skillId.startsWith(`${pluginId}-`) ? skillId : `${pluginId}-${skillId}` }
/** Sets `name` in a SKILL.md's frontmatter. */
function renameSkill(content: string, name: string): string {
  return content.replace(/^(---\r?\n[\s\S]*?)^name:[^\r\n]*/m, `$1name: ${name}`)
}
/** The id the built-in plugin takes in Claude (`gloss:new-plugin`); library plugins can't use it. */
const RESERVED_PLUGIN_ID = 'gloss'
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
  private watchProblem: string | null = null

  constructor(private readonly options: Options) {
    const base = resolve(options.directory)
    this.directory = join(base, 'library')
    this.runtime = join(base, 'runtime')
    this.stateFile = join(base, 'state.json')
    mkdirSync(this.directory, { recursive: true })
    mkdirSync(this.runtime, { recursive: true })
    try {
      const state: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!this.validState(state)) throw new Error('Invalid plugin deployment state.')
      this.state = state
      for (const d of this.state.deployments) {
        const skillId = relative(join(this.directory, d.pluginId, 'skills'), d.source)
        if (!PLUGIN_ID.test(skillId) || resolve(d.target) !== resolve(this.target(d.agentId, d.pluginId, skillId))) throw new Error('Deployment paths do not match their plugin and agent.')
      }
    } catch (error) { if (!isMissing(error)) this.stateProblem = 'Plugin deployment state could not be read. Restore state.json before changing deployments.' }
    this.fingerprint = this.sourceFingerprint()
    this.agentFingerprints = this.signatures()
  }

  private validState(state: unknown): state is State {
    if (!object(state) || state.schemaVersion !== 1 || !object(state.customDirectories) || !Array.isArray(state.deployments)) return false
    const directories = Object.entries(state.customDirectories)
      .every(([id, dir]) => id.startsWith('custom:') && typeof dir === 'string' && isAbsolute(dir))
    const deployment = (d: unknown): boolean => object(d)
      && typeof d.agentId === 'string'
      && typeof d.pluginId === 'string' && PLUGIN_ID.test(d.pluginId)
      && typeof d.target === 'string' && isAbsolute(d.target)
      && typeof d.source === 'string' && inside(join(this.directory, d.pluginId), d.source)
      && (d.mode === 'link' || d.mode === 'copy')
      && typeof d.hash === 'string'
    const trust = state.codexHookTrust === undefined || (object(state.codexHookTrust) && Object.values(state.codexHookTrust).every(v => typeof v === 'string'))
    return directories && state.deployments.every(deployment) && trust
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
    const path = this.safe(join(this.folder(id), 'plugin.json'))
    let source: string
    try { source = readFileSync(path, 'utf8') }
    catch (error) {
      if (isMissing(error)) throw new Error('This plugin is incomplete because plugin.json is missing. Delete its folder from the library to clean up its remaining files.', { cause: error })
      throw error
    }
    const value: unknown = JSON.parse(source)
    if (!object(value) || value.schemaVersion !== 1
      || typeof value.name !== 'string' || !value.name.trim()
      || typeof value.description !== 'string'
      || !strings(value.connections) || !strings(value.enabledAgents)) throw new Error('Invalid plugin.json. Expected schemaVersion, name, description, connections and enabledAgents.')
    if (Object.keys(value).some(k => !MANIFEST_KEYS.includes(k))) throw new Error('This plugin manifest contains unsupported fields. Plugins support skills and references to shared MCP connections.')
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
      if (!PLUGIN_ID.test(flatSkillName(id, entry.name))) throw new Error(`${entry.name}: the plugin id and skill name together must fit within 64 characters.`)
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
      const metadata = this.invocationMetadata(id, entry.name)
      const invocation = skillInvocation(raw, metadata).invocation
      return { invocation, id: entry.name, name: entry.name.startsWith(`${id}-`) ? entry.name.slice(id.length + 1) : entry.name, description: field('description'), path: `skills/${entry.name}/SKILL.md`, files: this.files(dir) }
    })
  }
  private invocationMetadata(id: string, skillId: string): string | undefined {
    const path = this.file(id, `skills/${skillId}/agents/openai.yaml`)
    return exists(path) ? this.readText(path) : undefined
  }
  private readText(file: string): string {
    this.safe(file)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Only text files up to 1 MB can be opened here.')
    const content = readFileSync(file, 'utf8')
    if (content.includes('\0')) throw new Error('This file is binary. Open the plugin folder to inspect it.')
    return content
  }
  private sources(): { id: string; manifest: PluginManifest; skills: PluginSkill[]; subagents: Subagent[]; hooks: PluginHook[]; problems: string[] }[] {
    return readdirSync(this.directory, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).map(d => {
      const id = d.name
      let manifest: PluginManifest = { schemaVersion: 1, name: id, description: '', connections: [], enabledAgents: [] }
      let skills: PluginSkill[] = []
      let subagents: Subagent[] = []
      let hooks: PluginHook[] = []
      const problems: string[] = []
      try {
        this.id(id); manifest = this.manifest(id)
        if (id === RESERVED_PLUGIN_ID) throw new Error(`The plugin id ${RESERVED_PLUGIN_ID} is reserved for Gloss’s built-in plugin. Rename this plugin’s folder.`)
        this.files(this.folder(id))
        if (NATIVE_PARTS.some(name => exists(join(this.folder(id), name)))) throw new Error('Commands, embedded servers and native plugin manifests are not loaded. Use skills, subagents, hooks and shared MCP connection references.')
        skills = this.scanSkills(id)
        subagents = this.scanSubagents(id)
        hooks = this.scanHooks(id)
      } catch (error) { problems.push(message(error)) }
      return { id, manifest, skills, subagents, hooks, problems }
    })
  }
  private scanSubagents(id: string): Subagent[] {
    const root = join(this.folder(id), 'agents')
    if (!exists(root)) return []
    return readdirSync(this.safe(root), { withFileTypes: true }).map(entry => {
      if (!entry.isFile()) throw new Error('agents/ holds one .md file per subagent, no folders.')
      return parseSubagent(id, entry.name, this.readText(join(root, entry.name)))
    })
  }
  private scanHooks(id: string): PluginHook[] {
    const file = join(this.folder(id), 'hooks', 'hooks.json')
    return exists(file) ? parseHooks(this.readText(file)) : []
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
    const agentState = (p: (typeof sources)[number], agent: Agent): PluginAgentState => {
      const enabled = p.manifest.enabledAgents.includes(agent.id)
      const custom = agent.id.startsWith('custom:')
      const configured = !custom || !!this.state.customDirectories[agent.id]
      const issues = [...p.problems, ...this.blockers(p.manifest, agent.id)]
      const deploymentError = deploymentErrors.get(`${agent.id}:${p.id}`)
      const status: PluginAgentState['status'] = deploymentError ? 'error'
        : issues.length || !configured ? 'setup'
        : this.pending.has(agent.id) ? 'pending'
        : enabled ? 'ready' : 'off'
      const message = deploymentError ?? issues[0]
        ?? (!configured ? 'Configure a skill directory for this custom agent.'
          : custom && p.skills.some(s => s.invocation !== 'automatic') ? 'Direct-only invocation is unverified for this custom agent.'
          : status === 'pending' ? 'The selected availability will apply when the active turn finishes.'
          : '')
      return {
        ...agent,
        enabled,
        status,
        support: !custom ? 'tested' : configured ? 'configured' : 'unknown',
        skillDirectory: this.state.customDirectories[agent.id],
        message
      }
    }
    const builtin = this.builtinPlugin(agents)
    const plugins: PersonalPlugin[] = sources.map(p => ({
      ...p.manifest,
      id: p.id,
      directory: join(this.directory, p.id),
      skills: p.skills,
      subagents: p.subagents.map(({ instructions: _, ...s }) => s),
      hooks: p.hooks,
      problems: p.problems,
      agents: agents.map(agent => agentState(p, agent))
    }))
    const connections = this.options.connections().map(s => ({
      name: s.name,
      transport: 'type' in s ? s.type : 'stdio' as const,
      usedBy: plugins.filter(p => p.connections.some(n => mcpName(n) === mcpName(s.name))).map(p => p.name)
    }))
    const errors = [this.stateProblem, this.watchProblem].filter((e): e is string => !!e)
    return { directory: this.directory, plugins: builtin ? [builtin, ...plugins] : plugins, connections, errors }
  }

  /** The agents a new plugin is on for: every agent that can take one (a custom profile needs its skill directory). */
  private defaultAgents(): string[] {
    return this.options.agents().filter(a => !a.id.startsWith('custom:') || !!this.state.customDirectories[a.id]).map(a => a.id)
  }
  private file(id: string, path: string): string {
    const part = typeof path === 'string' && (/^agents\/[a-z0-9][a-z0-9-]{0,63}\.md$/.test(path) || path === 'hooks/hooks.json')
    if (typeof path !== 'string' || (!path.startsWith('skills/') && !part) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Choose a relative file path within a skill, a subagent or the hooks file.')
    return this.safe(join(this.folder(id), path))
  }
  readFile(id: string, path: string): PluginFile {
    if (id === BUILTIN_PLUGIN_ID && this.options.settings) {
      const skill = BUILTIN_SKILLS.find(b => path === `skills/${b.claude}/SKILL.md`)
      if (!skill) throw new Error('Unknown file.')
      const content = this.builtinContent(skill)
      return { path, content, revision: hash(content) }
    }
    const content = this.readText(this.file(id, path)); return { path, content, revision: hash(content) } }
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
    mkdirSync(target, { recursive: true })
    // Compared by real path, so a link or another spelling of the same folder is caught too.
    const canonical = realpathSync(target)
    const real = (dir: string): string => { try { return realpathSync(dir) } catch { return resolve(dir) } }
    const overlaps = (a: string, b: string): boolean => {
      const [x, y] = process.platform === 'win32' ? [a.toLowerCase(), b.toLowerCase()] : [a, b]
      return inside(x, y) || inside(y, x)
    }
    if (sharedRoots.some(root => overlaps(real(root), canonical)) || overlaps(real(this.directory), canonical) || overlaps(real(this.runtime), canonical)) throw new Error('Use a directory separate from the library and other agents’ discovery roots.')
    if (Object.entries(this.state.customDirectories).some(([id, dir]) => id !== agentId && overlaps(real(dir), canonical))) throw new Error('Each custom agent needs its own skill directory for independent availability.')
    for (const skill of BUILTIN_SKILLS) {
      const previous = this.builtinFolder(agentId, skill)
      if (previous && exists(previous) && this.ownsBuiltin(previous, skill.flat)) rmSync(previous, { recursive: true })
    }
    this.state.customDirectories[agentId] = canonical; this.persist(); this.changed()
  }

  private assertState(): void { if (this.stateProblem) throw new Error(this.stateProblem) }
  private persist(): void { this.assertState(); atomic(this.stateFile, JSON.stringify(this.state, null, 2) + '\n') }
  private contentHash(root: string, overrides: ReadonlyMap<string, string> = new Map()): string {
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
          const rel = relative(root, path)
          entries.push(rel, hash(overrides.get(rel) ?? readFileSync(path)))
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
  /** `rename`: deliver a copy whose SKILL.md is named this, for an agent that names skills by their frontmatter. */
  private deploy(source: string, target: string, agentId: string, pluginId: string, rename?: string): void {
    this.safe(source)
    this.assertTargetParents(agentId, dirname(target))
    const recorded = this.state.deployments.find(d => d.target === target)
    if (recorded) this.assertOwned(recorded)
    else if (exists(target)) throw new Error(`An existing folder occupies ${target}. Gloss will not replace it.`)
    if (!rename && recorded && exists(target) && recorded.source === source && recorded.mode === 'link') return
    const skillFile = rename ? renameSkill(readFileSync(join(source, 'SKILL.md'), 'utf8'), rename) : undefined
    const digest = this.contentHash(source, skillFile === undefined ? undefined : new Map([['SKILL.md', skillFile]]))
    if (recorded && exists(target) && recorded.mode === 'copy' && recorded.hash === digest) return
    mkdirSync(dirname(target), { recursive: true })
    const staged = `${target}.gloss-${randomUUID()}`
    let mode: Deployment['mode'] = 'link'
    try {
      try {
        if (skillFile !== undefined) { mode = 'copy'; cpSync(source, staged, { recursive: true, errorOnExist: true, force: false }); writeFileSync(join(staged, 'SKILL.md'), skillFile) }
        else (this.options.link ?? symlinkSync)(source, staged, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
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
    if (agentId === 'codex') return join(this.runtime, 'codex', '.agents', 'skills', flatSkillName(pluginId, skillId))
    if (agentId === 'opencode') return join(this.runtime, 'opencode', 'skills', flatSkillName(pluginId, skillId))
    const dir = this.state.customDirectories[agentId]
    if (!dir) throw new Error('Configure the custom agent’s skill directory.')
    return join(dir, `gloss-${flatSkillName(pluginId, skillId)}`)
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
  /** A built-in skill's folder for an agent, or undefined when it can't get it (SPEC → Plugins → Import). */
  private builtinFolder(agentId: string, skill: BuiltinSkill = BUILTIN_SKILLS[0]): string | undefined {
    const root = join(this.runtime, 'builtin')
    if (agentId === 'claude') return join(root, 'claude', 'skills', skill.claude)
    if (agentId === 'codex') return join(root, 'codex', '.agents', 'skills', skill.flat)
    if (agentId === 'opencode') return join(root, 'opencode', 'skills', skill.flat)
    const dir = this.state.customDirectories[agentId]
    return dir ? join(dir, skill.flat) : undefined
  }
  /** A folder holding only a built-in skill (`name` its current or an earlier name), so Gloss may update or remove it. */
  private ownsBuiltin(folder: string, name: string): boolean {
    const stat = lstatSync(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const items = readdirSync(folder)
    return items.length === 1 && items[0] === 'SKILL.md' && readFileSync(join(folder, 'SKILL.md'), 'utf8').startsWith(`---\nname: ${name}\n`)
  }
  /** A built-in skill's SKILL.md with this machine's paths. They aren't part of the library and can't be turned off. */
  private builtinContent(skill: BuiltinSkill, name = skill.flat): string {
    return skill.render({ library: this.directory, settings: this.options.settings ?? '', runtime: this.runtime, agents: this.options.agents(), defaultAgents: this.defaultAgents() }, name)
  }
  /** The built-in plugin as the Plugins screen shows it: read-only, on for every agent that can get it. */
  private builtinPlugin(agents: Agent[]): PersonalPlugin | undefined {
    if (!this.options.settings) return undefined
    return {
      schemaVersion: 1, id: BUILTIN_PLUGIN_ID, builtin: true, name: 'Gloss',
      description: 'Built into Gloss: lets any agent create or import a plugin, and work out why one doesn’t behave as expected.',
      connections: [], enabledAgents: agents.map(a => a.id), directory: join(this.runtime, 'builtin'), problems: [], subagents: [], hooks: [],
      skills: BUILTIN_SKILLS.map(skill => ({
        id: skill.claude, name: skill.claude, description: /^description: "(.*)"$/m.exec(this.builtinContent(skill))?.[1] ?? '',
        path: `skills/${skill.claude}/SKILL.md`, files: ['SKILL.md'], invocation: 'automatic' as const
      })),
      agents: agents.map(agent => {
        const custom = agent.id.startsWith('custom:')
        const configured = !custom || !!this.state.customDirectories[agent.id]
        const blocked = BUILTIN_SKILLS.find(skill => !this.hasBuiltin(agent.id, skill) || (custom && !this.ownsBuiltin(this.builtinFolder(agent.id, skill)!, skill.flat)))
        return {
          ...agent, enabled: true, skillDirectory: this.state.customDirectories[agent.id],
          support: !custom ? 'tested' : configured ? 'configured' : 'unknown',
          status: !blocked ? 'ready' : configured ? 'error' : 'setup',
          message: !blocked ? '' : !configured ? 'Gets it once this custom agent’s skill directory is set.'
            : custom ? `A folder Gloss didn’t write occupies ${this.builtinFolder(agent.id, blocked)}. It was kept, so this agent doesn’t get that skill.`
            : 'The built-in skills could not be written. Restart Gloss to retry.'
        }
      })
    }
  }
  private deliverBuiltin(): void {
    if (!this.options.settings) return
    for (const agent of this.options.agents()) for (const skill of BUILTIN_SKILLS) {
      const folder = this.builtinFolder(agent.id, skill)
      if (!folder) continue
      try {
        if (skill === BUILTIN_SKILLS[0]) this.removeLegacyBuiltin(agent.id, folder)
        // A custom agent's directory may hold the user's own content: never replace it.
        if (agent.id.startsWith('custom:') && exists(folder) && !this.ownsBuiltin(folder, skill.flat)) continue
        const content = this.builtinContent(skill, agent.id === 'claude' ? skill.claude : skill.flat)
        const file = join(folder, 'SKILL.md')
        if (!exists(file) || readFileSync(file, 'utf8') !== content) atomic(file, content)
        if (agent.id === 'claude') {
          const manifest = join(this.runtime, 'builtin', 'claude', '.claude-plugin', 'plugin.json')
          const value = JSON.stringify({ name: 'gloss', description: 'Built into Gloss.' }) + '\n'
          if (!exists(manifest) || readFileSync(manifest, 'utf8') !== value) atomic(manifest, value)
        }
      } catch (error) { console.warn(`[plugins] Could not write the built-in skill ${skill.flat} for ${agent.id}:`, message(error)) }
    }
  }
  /** Removes the built-in skill's folders under an earlier name, only where Gloss wrote them. */
  private removeLegacyBuiltin(agentId: string, folder: string): void {
    for (const name of LEGACY_BUILTIN_SKILLS) {
      const old = join(dirname(folder), name)
      if (!exists(old)) continue
      if (!agentId.startsWith('custom:') || this.ownsBuiltin(old, name)) rmSync(old, { recursive: true })
    }
  }
  private hasBuiltin(agentId: string, skill: BuiltinSkill = BUILTIN_SKILLS[0]): boolean {
    const folder = this.builtinFolder(agentId, skill)
    return !!this.options.settings && !!folder && exists(join(folder, 'SKILL.md'))
  }
  reconcile(): void {
    this.deliverBuiltin()
    if (this.stateProblem) return
    this.errors.clear()
    const expected = new Set<string>()
    for (const d of this.state.deployments) if (this.options.busy?.(d.agentId)) expected.add(d.target)
    for (const p of this.sources()) for (const agent of this.options.agents()) {
      if (this.options.busy?.(agent.id)) continue
      if (!p.manifest.enabledAgents.includes(agent.id) || p.problems.length || this.blockers(p.manifest, agent.id).length) continue
      try {
        // Claude namespaces plugin skills itself; elsewhere a skill is renamed <plugin-id>-<skill> unless it already is.
        const plans = p.skills.map(s => ({ source: join(this.folder(p.id), 'skills', s.id), target: this.target(agent.id, p.id, s.id), rename: agent.id !== 'claude' && flatSkillName(p.id, s.id) !== s.id ? flatSkillName(p.id, s.id) : undefined }))
        for (const plan of plans) {
          expected.add(plan.target)
          const record = this.state.deployments.find(d => d.target === plan.target)
          if (record) {
            if (record.source !== plan.source) throw new Error(`Another plugin already uses the skill name ${relative(dirname(plan.target), plan.target)}. Rename this skill before enabling it.`)
            this.assertOwned(record)
          }
          else if (exists(plan.target)) throw new Error(`Existing content at ${plan.target} was preserved. Choose another skill name or directory.`)
        }
        for (const plan of plans) this.deploy(plan.source, plan.target, agent.id, p.id, plan.rename)
        if (agent.id === 'claude') {
          const parent = join(this.runtime, 'claude', p.id, '.claude-plugin')
          this.assertTargetParents(agent.id, parent)
          const file = join(parent, 'plugin.json')
          const content = JSON.stringify({ name: p.id, description: p.manifest.description }) + '\n'
          if (!exists(file) || lstatSync(file).isSymbolicLink() || readFileSync(file, 'utf8') !== content) atomic(file, content)
        }
      } catch (error) {
        this.errors.set(`${agent.id}:${p.id}`, message(error))
        // All or nothing: an agent never gets part of a plugin. What can't be removed stays recorded.
        for (const d of this.state.deployments.filter(d => d.agentId === agent.id && d.pluginId === p.id)) {
          expected.delete(d.target)
          try { this.removeTarget(d) } catch { /* reported by deploymentErrors */ }
        }
      }
    }
    for (const d of [...this.state.deployments]) if (!expected.has(d.target)) {
      try { this.removeTarget(d) } catch (error) {
        const pluginId = relative(this.directory, d.source).split(sep)[0]
        for (const agent of this.options.agents()) this.errors.set(`${agent.id}:${pluginId}`, message(error))
      }
    }
    this.removeStaleClaudePlugins()
    this.writeReport()
  }
  /** Drops the generated `.claude-plugin` of a plugin Claude no longer gets, once its skills are gone. */
  private removeStaleClaudePlugins(): void {
    const root = join(this.runtime, 'claude')
    if (!exists(root)) return
    const enabled = new Set(this.sources().filter(p => p.manifest.enabledAgents.includes('claude')).map(p => p.id))
    for (const id of readdirSync(root)) {
      if (enabled.has(id) || !PLUGIN_ID.test(id) || this.state.deployments.some(d => d.agentId === 'claude' && d.pluginId === id)) continue
      const dir = join(root, id)
      try {
        this.assertTargetParents('claude', dir)
        for (const generated of ['.claude-plugin', 'agents', 'hooks']) rmSync(join(dir, generated), { recursive: true, force: true })
        const skills = join(dir, 'skills')
        if (exists(skills) && readdirSync(skills).length === 0) rmSync(skills, { recursive: true })
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
      } catch { /* left for the next reconcile */ }
    }
  }
  /**
   * Adds the enabled plugins to Gloss's process and session configuration for the agent,
   * never to native user settings. A plugin with a problem is left out (the Plugins screen
   * shows why); it never stops the agent from starting.
   */
  /** The plugins an agent gets: on for it, without a problem, a missing connection or a failed deployment. */
  private deliverable(agentId: string, sources = this.sources(), deploymentErrors = this.deploymentErrors()): ReturnType<PluginLibrary['sources']> {
    if (this.stateProblem) return []
    return sources.filter(p => p.manifest.enabledAgents.includes(agentId)
      && !p.problems.length
      && !this.blockers(p.manifest, agentId).length
      && !deploymentErrors.has(`${agentId}:${p.id}`))
  }
  /** Makes a generated runtime folder hold exactly `files` (flat), writing only what changed. No files: no folder. */
  private generate(agentId: string, folder: string, files: Record<string, string>): void {
    this.assertTargetParents(agentId, folder)
    const names = Object.keys(files)
    if (exists(folder)) {
      if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) throw new Error(`Something other than Gloss’s generated folder is at ${folder}.`)
      for (const name of readdirSync(folder)) if (!names.includes(name)) rmSync(join(folder, name), { recursive: true, force: true })
      if (!names.length) { rmSync(folder, { recursive: true, force: true }); return }
    }
    for (const name of names) {
      const file = join(folder, name)
      if (!exists(file) || readFileSync(file, 'utf8') !== files[name]) atomic(file, files[name])
    }
  }
  /**
   * Writes an agent's generated subagents and hooks (SPEC → Plugins → Subagents and hooks). Like the
   * built-in skill, rewritten on each start; a busy agent keeps what it has until it's idle.
   */
  private generateParts(agentId: PartAgent, plugins: ReturnType<PluginLibrary['sources']>): void {
    if (this.options.busy?.(agentId)) return
    try {
      if (agentId === 'claude') for (const p of plugins) {
        const hooks = nativeHooks(p.hooks, 'claude')
        this.generate(agentId, join(this.runtime, 'claude', p.id, 'agents'), Object.fromEntries(p.subagents.map(s => [`${s.id}.md`, claudeSubagent(s)])))
        this.generate(agentId, join(this.runtime, 'claude', p.id, 'hooks'), Object.keys(hooks).length ? { 'hooks.json': JSON.stringify({ hooks }, null, 2) + '\n' } : {})
      }
      if (agentId === 'codex') this.generate(agentId, join(this.runtime, 'codex', 'agents'), Object.fromEntries(plugins.flatMap(p => p.subagents.map(s => [`${flatName(p.id, s.id)}.toml`, codexRole(s)]))))
      if (agentId === 'opencode') {
        const hooks = plugins.flatMap(p => openCodeHooks(p.hooks))
        this.generate(agentId, join(this.runtime, 'opencode', 'hooks'), hooks.length ? {
          'package.json': JSON.stringify({ name: 'gloss-hooks', private: true, type: 'module', exports: { '.': './index.js' } }, null, 2) + '\n',
          'index.js': OPENCODE_HOOK_PLUGIN,
          'hooks.json': JSON.stringify(hooks, null, 2) + '\n'
        } : {})
      }
    } catch (error) { console.warn(`[plugins] Could not write subagents and hooks for ${agentId}:`, message(error)) }
  }
  /**
   * Records Codex's hashes for the hooks Gloss passed it, so the next start marks them trusted:
   * Codex skips untrusted hooks, and trusting them through Codex writes to `~/.codex/config.toml`.
   * Gloss trusts only hooks from its own process configuration (`sessionFlags`). True when a
   * hook was untrusted and its hash is new, so the agent needs one restart to run it.
   */
  trustCodexHooks(hooks: CodexHook[]): boolean {
    if (this.stateProblem) return false
    const flags = hooks.filter(h => h.source === 'sessionFlags' && typeof h.key === 'string' && typeof h.currentHash === 'string')
    const previous = this.state.codexHookTrust ?? {}
    const next = Object.fromEntries(flags.map(h => [h.key, h.currentHash]))
    const restart = flags.some(h => h.trustStatus !== 'trusted' && previous[h.key] !== h.currentHash)
    if (JSON.stringify(next) !== JSON.stringify(previous)) { this.state.codexHookTrust = next; this.persist() }
    return restart
  }
  /** Gloss's additions to Codex's `CODEX_CONFIG` (hooks with their trust, and subagent roles), merged into the user's. */
  private codexConfig(config: AgentConfig, plugins: ReturnType<PluginLibrary['sources']>): { env?: string; hooks: boolean } {
    const hooks: Record<string, unknown[]> = {}
    for (const p of plugins) for (const [event, groups] of Object.entries(nativeHooks(p.hooks, 'codex'))) (hooks[event] ??= []).push(...groups)
    const roles = Object.fromEntries(plugins.flatMap(p => p.subagents.map(s => {
      const name = flatName(p.id, s.id)
      return [name, { description: s.description, config_file: join(this.runtime, 'codex', 'agents', `${name}.toml`) }]
    })))
    if (!Object.keys(hooks).length && !Object.keys(roles).length) return { hooks: false }
    const raw = config.env?.CODEX_CONFIG ?? process.env.CODEX_CONFIG ?? '{}'
    let content: unknown
    try { content = JSON.parse(raw) } catch { content = null }
    if (!object(content) || (content.hooks !== undefined && !object(content.hooks)) || (content.agents !== undefined && !object(content.agents))) {
      console.warn('[plugins] CODEX_CONFIG must be a JSON object with object hooks and agents; subagents and hooks are left out.')
      return { hooks: false }
    }
    const own = object(content.hooks) ? content.hooks : {}
    const merged: Record<string, unknown> = { ...own }
    for (const [event, groups] of Object.entries(hooks)) merged[event] = [...(Array.isArray(own[event]) ? own[event] : []), ...groups]
    if (Object.keys(hooks).length) merged.state = { ...(object(own.state) ? own.state : {}), ...Object.fromEntries(Object.entries(this.state.codexHookTrust ?? {}).map(([key, hash]) => [key, { trusted_hash: hash }])) }
    const next = { ...content, ...(Object.keys(merged).length ? { hooks: merged } : {}), ...(Object.keys(roles).length ? { agents: { ...(object(content.agents) ? content.agents : {}), ...roles } } : {}) }
    return { env: JSON.stringify(next), hooks: Object.keys(hooks).length > 0 }
  }
  configureAgent(config: AgentConfig): AgentConfig {
    // Rewritten on every start, so a hand edit to the generated skill never reaches a session.
    this.deliverBuiltin()
    const builtin = this.hasBuiltin(config.id)
    const sources = this.stateProblem ? [] : this.sources()
    const enabled = this.deliverable(config.id, sources)
    if (isPartAgent(config.id)) this.generateParts(config.id, enabled)
    if (config.id === 'opencode') {
      if (!enabled.length && !builtin) return config
      const raw = config.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}'
      let content: unknown
      try { content = JSON.parse(raw) } catch { content = null }
      if (!object(content) || (content.skills !== undefined && !strings(content.skills))) {
        console.warn('[plugins] OPENCODE_CONFIG_CONTENT has no usable skills list; plugins are left out.')
        return config
      }
      const skills = [...new Set([
        ...(content.skills as string[] | undefined ?? []),
        ...(builtin ? [join(this.runtime, 'builtin', 'opencode', 'skills')] : []),
        ...(enabled.length ? [join(this.runtime, 'opencode', 'skills')] : [])
      ])]
      const next: Record<string, unknown> = { ...content, skills }
      const subagents = Object.fromEntries(enabled.flatMap(p => p.subagents.map(s => [flatName(p.id, s.id), openCodeSubagent(s)])))
      const hooks = enabled.some(p => openCodeHooks(p.hooks).length)
      if (Object.keys(subagents).length || hooks) {
        if ((content.agents !== undefined && !object(content.agents)) || (content.plugins !== undefined && !Array.isArray(content.plugins))) {
          console.warn('[plugins] OPENCODE_CONFIG_CONTENT has unusable agents or plugins; subagents and hooks are left out.')
        } else {
          if (Object.keys(subagents).length) next.agents = { ...(object(content.agents) ? content.agents : {}), ...subagents }
          if (hooks) next.plugins = [...(Array.isArray(content.plugins) ? content.plugins : []), pathToFileURL(join(this.runtime, 'opencode', 'hooks')).href]
        }
      }
      return { ...config, env: { ...config.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(next) } }
    }
    if ((config.id !== 'claude' && config.id !== 'codex') || (!enabled.length && !builtin)) return config
    const codex = config.id === 'codex' ? this.codexConfig(config, enabled) : { hooks: false }
    const decorate = (previous: Record<string, unknown>): Record<string, unknown> => {
      if (config.id === 'codex') {
        const roots = Array.isArray(previous.additionalRoots) ? previous.additionalRoots : []
        return { ...previous, additionalRoots: [
          ...roots,
          ...(builtin ? [join(this.runtime, 'builtin', 'codex')] : []),
          ...(enabled.length ? [join(this.runtime, 'codex')] : [])
        ] }
      }
      const claude = object(previous.claudeCode) ? previous.claudeCode : {}
      const options = object(claude.options) ? claude.options : {}
      const plugins = [
        ...(Array.isArray(options.plugins) ? options.plugins : []),
        ...(builtin ? [{ type: 'local', path: join(this.runtime, 'builtin', 'claude') }] : []),
        ...enabled.map(p => ({ type: 'local', path: join(this.runtime, 'claude', p.id) }))
      ]
      return { ...previous, claudeCode: { ...claude, options: { ...options, plugins } } }
    }
    return {
      ...config,
      ...(codex.env ? { env: { ...config.env, CODEX_CONFIG: codex.env } } : {}),
      ...(codex.hooks ? {
        afterStart: async (conn: { extRequest(method: string, params: Record<string, unknown>): Promise<unknown> }) => {
          // Hooks from Gloss's own configuration don't depend on a project; any folder lists them.
          const listed = await conn.extRequest('_codex/hooks/list', { cwd: homedir() })
          const hooks = object(listed) && Array.isArray(listed.hooks) ? listed.hooks as CodexHook[] : []
          return this.trustCodexHooks(hooks) ? this.configureAgent(config) : undefined
        }
      } : {}),
      sessionMeta: instructions => {
        const meta = config.sessionMeta?.(instructions) ?? {}
        return { new: decorate(meta.new ?? {}), load: decorate(meta.load ?? {}) }
      }
    }
  }
  /**
   * `runtime/delivery.json`: what each agent gets from each plugin and why it skips the rest, for
   * the doctor skill (SPEC → Plugins → Doctor). Gloss shows none of it on screen.
   */
  private writeReport(): void {
    try {
      const sources = this.sources()
      const errors = this.deploymentErrors()
      const report = { agents: Object.fromEntries(this.options.agents().map(agent => {
        const deliverable = new Set(this.deliverable(agent.id, sources, errors).map(p => p.id))
        const part = isPartAgent(agent.id) ? agent.id : undefined
        return [agent.id, { name: agent.name, plugins: Object.fromEntries(sources.map(p => {
          const on = p.manifest.enabledAgents.includes(agent.id)
          const delivered = deliverable.has(p.id)
          const reason = !on ? 'Off for this agent.' : delivered ? undefined
            : p.problems[0] ?? this.blockers(p.manifest, agent.id)[0] ?? errors.get(`${agent.id}:${p.id}`) ?? this.stateProblem ?? 'Not delivered.'
          const name = (id: string): string => agent.id === 'claude' ? `${p.id}:${id}` : flatName(p.id, id)
          return [p.id, {
            on, delivered, ...(reason ? { reason } : {}),
            skills: p.skills.map(s => agent.id === 'claude' ? `${p.id}:${s.name}` : agent.id.startsWith('custom:') ? `gloss-${flatSkillName(p.id, s.id)}` : flatSkillName(p.id, s.id)),
            subagents: p.subagents.map(s => part ? { name: name(s.id), delivered } : { name: s.id, delivered: false, reason: 'Custom agents get skills only.' }),
            hooks: p.hooks.map(h => {
              const plan = part ? planHook(h, part) : { delivered: false as const, reason: 'Custom agents get skills only.' }
              return { event: h.event, ...(h.matcher ? { matcher: h.matcher } : {}), command: h.command, ...(plan.delivered ? { delivered, as: { event: plan.event, ...(plan.matcher ? { matcher: plan.matcher } : {}) } } : { delivered: false, reason: plan.reason }) }
            })
          }]
        })) }]
      })) }
      const file = join(this.runtime, 'delivery.json')
      const content = JSON.stringify(report, null, 2) + '\n'
      if (!exists(file) || readFileSync(file, 'utf8') !== content) atomic(file, content)
    } catch (error) { console.warn('[plugins] Could not write the delivery report:', message(error)) }
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
  /** Picks up edits made outside Gloss. Without a watcher, they apply on the next Refresh. */
  startWatching(): void {
    this.reconcile()
    const lost = (error: unknown): void => {
      console.warn('[plugins] Could not watch the plugin library:', message(error))
      this.watcher?.close()
      this.watcher = undefined
      this.watchProblem = 'Gloss stopped noticing edits made outside it. Use Refresh on an agent to apply them, or restart Gloss.'
      this.options.changed?.([])
    }
    try {
      this.watcher = watch(this.directory, { recursive: true }, () => {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          const next = this.sourceFingerprint()
          if (next !== this.fingerprint) this.changed()
        }, 350)
      })
      this.watcher.on('error', lost)
    } catch (error) { lost(error) }
  }
  close(): void { clearTimeout(this.timer); this.watcher?.close() }
}
