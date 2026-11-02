import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLibrary } from './plugins'
import { getAgentConfig } from './agents'
import type { McpServer } from '../shared/mcp'

let root: string
let library: PluginLibrary
let connections: McpServer[]
let busy: Set<string>
const agents = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'opencode', name: 'OpenCode' }, { id: 'custom:local', name: 'Local agent' }]
const changed = vi.fn()
function make(copy = false): PluginLibrary {
  return new PluginLibrary({ directory: join(root, 'plugins'), agents: () => agents, connections: () => connections, busy: id => busy.has(id), changed,
    ...(copy ? { link: (() => { throw Object.assign(new Error('No link privilege'), { code: 'EPERM' }) }) as typeof symlinkSync } : {}) })
}
/** Writes a file into a plugin's folder, as an agent or the user would. */
function put(id: string, path: string, content: string): void {
  const file = join(library.directory, id, path)
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content)
}
function manifest(id: string, fields: { enabledAgents?: string[]; connections?: string[] } = {}): void {
  put(id, 'plugin.json', JSON.stringify({ schemaVersion: 1, name: id, description: '', connections: [], enabledAgents: [], ...fields }))
}
/** A plugin written into the library, off for every agent unless `enabledAgents` says otherwise. */
function addPlugin(id: string, { skills = { instructions: `Instructions for ${id}.` }, ...fields }: { skills?: Record<string, string>; enabledAgents?: string[]; connections?: string[] } = {}): string {
  for (const [skill, description] of Object.entries(skills)) put(id, `skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${skill}\n`)
  manifest(id, fields)
  return id
}
function record(id: string) { return library.list().plugins.find(p => p.id === id)! }
function deployments(): { target: string; source: string; mode: string; agentId: string }[] { return JSON.parse(readFileSync(join(root, 'plugins/state.json'), 'utf8')).deployments }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gloss-plugin-test-'))
  connections = [{ name: 'Docs', type: 'http', url: 'https://example.test/mcp', headers: [] }]
  busy = new Set(); changed.mockClear(); library = make()
})
afterEach(() => {
  library.close()
  const resolved = resolve(root)
  if (!resolved.startsWith(resolve(tmpdir()) + sep) || !resolved.slice(resolve(tmpdir()).length + 1).startsWith('gloss-plugin-test-')) throw new Error('Unexpected test cleanup path.')
  rmSync(resolved, { recursive: true, force: true })
})

it('shares source files through native projections and never touches native user skill folders', () => {
  const id = addPlugin('review')
  const skill = record(id).skills[0]
  put(id, `skills/${skill.id}/references/checklist.md`, 'First checklist')
  for (const agent of ['claude', 'codex', 'opencode']) library.enable(id, agent, true)
  const targets = deployments()
  expect(targets).toHaveLength(3)
  for (const target of targets) {
    expect(target.target.startsWith(join(root, 'plugins/runtime'))).toBe(true)
    // Claude gets a link; Codex and OpenCode name skills by their frontmatter, so they get renamed copies.
    expect(lstatSync(target.target).isSymbolicLink()).toBe(target.agentId === 'claude')
    expect(readFileSync(join(target.target, 'references/checklist.md'), 'utf8')).toBe('First checklist')
  }
  put(id, `skills/${skill.id}/references/checklist.md`, 'Updated checklist'); library.reconcile()
  for (const target of targets) expect(readFileSync(join(target.target, 'references/checklist.md'), 'utf8')).toBe('Updated checklist')
  library.enable(id, 'codex', false)
  expect(deployments()).toHaveLength(2)
  expect(existsSync(record(id).directory)).toBe(true)
  expect(record(id).agents.find(a => a.id === 'claude')!.enabled).toBe(true)
})

it('preserves adapter instructions and native OpenCode settings when adding plugin delivery', () => {
  const id = addPlugin('writing')
  for (const agent of ['claude', 'codex', 'opencode']) library.enable(id, agent, true)
  const claude = library.configureAgent(getAgentConfig('claude')).sessionMeta!('thread guidance')
  expect(claude.new).toMatchObject({ systemPrompt: { append: 'thread guidance' }, claudeCode: { options: { plugins: [{ type: 'local', path: join(root, 'plugins/runtime/claude/writing') }] } } })
  expect(claude.load).toEqual(claude.new)
  const codex = library.configureAgent(getAgentConfig('codex')).sessionMeta!('thread guidance')
  expect(codex.new).toMatchObject({ jetbrains: { air: { customInstructions: 'thread guidance' } }, additionalRoots: [join(root, 'plugins/runtime/codex')] })
  const config = library.configureAgent({ ...getAgentConfig('opencode'), env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['native.md'], skills: ['team-skills'], providers: { local: { model: 'test' } } }) } })
  expect(JSON.parse(config.env!.OPENCODE_CONFIG_CONTENT)).toEqual({ instructions: ['native.md'], skills: ['team-skills', join(root, 'plugins/runtime/opencode/skills')], providers: { local: { model: 'test' } } })
  library.enable(id, 'codex', false)
  expect(library.configureAgent(getAgentConfig('codex')).sessionMeta!('').new).not.toHaveProperty('additionalRoots')
})

it('requires custom agent configuration and refuses pre-existing deployment content', () => {
  const id = addPlugin('writing')
  const custom = join(root, 'custom-skills')
  expect(() => library.enable(id, 'custom:local', true)).toThrow(/Configure/)
  library.setSkillDirectory('custom:local', custom)
  const destination = join(custom, 'gloss-writing-instructions')
  mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'original.txt'), 'Keep me')
  expect(() => library.enable(id, 'custom:local', true)).toThrow(/preserved/)
  expect(readFileSync(join(destination, 'original.txt'), 'utf8')).toBe('Keep me')
  expect(record(id).enabledAgents).not.toContain('custom:local')
})

it('deploys to a configured custom root and keeps the source on disable', () => {
  const id = addPlugin('writing')
  library.setSkillDirectory('custom:local', join(root, 'custom-skills'))
  library.enable(id, 'custom:local', true)
  expect(record(id).agents.find(a => a.id === 'custom:local')).toMatchObject({ enabled: true, support: 'configured', status: 'ready' })
  library = make(); library.reconcile()
  const target = deployments()[0].target
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('writing-instructions')
  library.enable(id, 'custom:local', false)
  expect(existsSync(target)).toBe(false)
  expect(existsSync(record(id).directory)).toBe(true)
})

it('rejects traversal and symlink escapes when reading files', () => {
  const id = addPlugin('writing')
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'Keep me')
  for (const path of ['../outside/secret.txt', 'skills/../../outside/secret.txt', 'skills/x/C:/secret', 'skills\\x\\secret']) expect(() => library.readFile(id, path)).toThrow()
  const linked = join(record(id).directory, 'skills', record(id).skills[0].id, 'linked')
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => library.readFile(id, `skills/instructions/linked/secret.txt`)).toThrow(/Linked files/)
})

it('tracks copy fallback updates and preserves diverged deployment files', () => {
  library = make(true)
  const id = addPlugin('writing')
  library.enable(id, 'codex', true)
  const d = deployments()[0]
  expect(d.mode).toBe('copy')
  const file = library.readFile(id, record(id).skills[0].path)
  put(id, file.path, file.content + '\nNew instruction\n'); library.reconcile()
  expect(readFileSync(join(d.target, 'SKILL.md'), 'utf8')).toContain('New instruction')
  writeFileSync(join(d.target, 'notes.txt'), 'Deployment edit')
  expect(() => library.enable(id, 'codex', false)).toThrow(/local edits/)
  expect(readFileSync(join(d.target, 'notes.txt'), 'utf8')).toBe('Deployment edit')
  expect(existsSync(record(id).directory)).toBe(true)
})

it('does not remove a directory that replaced a managed link', () => {
  const id = addPlugin('writing'); library.enable(id, 'claude', true)
  const target = deployments()[0].target
  rmSync(target); mkdirSync(target); writeFileSync(join(target, 'user.txt'), 'Unrelated files')
  expect(() => library.enable(id, 'claude', false)).toThrow(/replaced outside/)
  expect(readFileSync(join(target, 'user.txt'), 'utf8')).toBe('Unrelated files')
})

it('reports missing deployments on read and safely clears its own dangling links', () => {
  const id = addPlugin('writing'); library.enable(id, 'claude', true)
  const d = deployments()[0]
  rmSync(d.target)
  expect(record(id).agents.find(a => a.id === 'claude')!.status).toBe('error')
  library.reconcile()
  expect(existsSync(d.target)).toBe(true)
  rmSync(d.source, { recursive: true })
  library.reconcile()
  expect(deployments()).toHaveLength(0)
})

it('refuses a tampered deployment registry pointing at an unrelated folder', () => {
  const id = addPlugin('writing'); library.enable(id, 'codex', true)
  const unrelated = join(root, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'Keep me')
  const path = join(root, 'plugins/state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  state.deployments[0].target = unrelated
  writeFileSync(path, JSON.stringify(state))
  library = make()
  expect(library.list().errors).toHaveLength(1)
  expect(() => library.enable(id, 'codex', false)).toThrow(/deployment state/)
  expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('Keep me')
})

it('keeps active deployments until the turn ends', () => {
  const id = addPlugin('writing'); library.enable(id, 'codex', true)
  const target = deployments()[0].target
  busy.add('codex'); library.enable(id, 'codex', false); library.markPending(['codex'])
  expect(existsSync(target)).toBe(true)
  expect(record(id).agents.find(a => a.id === 'codex')).toMatchObject({ enabled: false, status: 'pending' })
  busy.clear(); library.reconcile(); library.refreshed('codex')
  expect(existsSync(target)).toBe(false)
  expect(record(id).agents.find(a => a.id === 'codex')!.status).toBe('off')
})

it('reports missing or unsupported connection requirements', () => {
  const id = addPlugin('review', { connections: ['Docs'] }); library.enable(id, 'codex', true)
  expect(record(id).agents.find(a => a.id === 'codex')!.status).toBe('ready')
  const other = addPlugin('other', { connections: ['Missing'] })
  expect(() => library.enable(other, 'claude', true)).toThrow(/Configure the Missing/)
  connections = [{ name: 'Events', type: 'sse', url: 'https://example.test/sse', headers: [] }]
  manifest(other, { connections: ['Events'] })
  expect(() => library.enable(other, 'codex', true)).toThrow(/SSE/)
})

it('rejects native executable components and malformed deployment state without overwriting them', () => {
  const id = addPlugin('writing')
  mkdirSync(join(record(id).directory, 'commands'))
  expect(() => library.enable(id, 'claude', true)).toThrow(/are not loaded/)
  rmSync(join(record(id).directory, 'commands'), { recursive: true })
  // A Claude Code plugin's own hooks file isn't Gloss's format.
  mkdirSync(join(record(id).directory, 'hooks'))
  writeFileSync(join(record(id).directory, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
  expect(() => library.enable(id, 'claude', true)).toThrow(/Gloss’s hook format/)
  const state = join(root, 'plugins/state.json'); writeFileSync(state, '{broken')
  library = make()
  expect(library.list().errors).toHaveLength(1)
  expect(() => library.enable(id, 'codex', true)).toThrow(/deployment state/)
  expect(readFileSync(state, 'utf8')).toBe('{broken')
})

it('starts agents without a plugin whose deployment has a problem, or with unreadable state', () => {
  const id = addPlugin('writing')
  library.enable(id, 'claude', true); library.enable(id, 'codex', true)
  const codex = deployments().find(d => d.agentId === 'codex')!
  rmSync(codex.target, { recursive: true }); mkdirSync(codex.target)
  expect(library.configureAgent(getAgentConfig('codex')).sessionMeta!('').new).not.toHaveProperty('additionalRoots')
  // Only the broken agent loses it.
  expect(library.configureAgent(getAgentConfig('claude')).sessionMeta!('').new).toHaveProperty('claudeCode.options.plugins')
  writeFileSync(join(root, 'plugins/state.json'), '{broken')
  library = make()
  expect(library.configureAgent(getAgentConfig('claude')).sessionMeta!('x')).toEqual(getAgentConfig('claude').sessionMeta!('x'))
})

it('removes a partly deployed plugin when one of its skills fails to deploy', () => {
  let links = 0
  library = new PluginLibrary({ directory: join(root, 'plugins'), agents: () => agents, connections: () => connections, busy: () => false, changed,
    link: ((source, target, type) => {
      if (++links === 2) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' })
      symlinkSync(source, target, type)
    }) as typeof symlinkSync })
  const id = addPlugin('writing', { skills: { instructions: 'Write clearly', second: 'Another skill' } })
  expect(() => library.enable(id, 'claude', true)).toThrow(/Disk full/)
  expect(deployments()).toEqual([])
  expect(existsSync(join(root, 'plugins/runtime/claude/writing/skills/instructions'))).toBe(false)
  expect(record(id).enabledAgents).not.toContain('claude')
})

it('refuses a custom skill directory that reaches another one through a link', () => {
  const agentsWithTwo = [...agents, { id: 'custom:other', name: 'Other agent' }]
  library = new PluginLibrary({ directory: join(root, 'plugins'), agents: () => agentsWithTwo, connections: () => connections, busy: () => false, changed })
  const first = join(root, 'first-skills')
  library.setSkillDirectory('custom:local', first)
  const alias = join(root, 'alias')
  symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => library.setSkillDirectory('custom:other', join(alias, 'nested'))).toThrow(/its own skill directory/)
  expect(() => library.setSkillDirectory('custom:other', join(root, 'plugins/runtime'))).toThrow(/separate from the library/)
})

it("removes Claude's generated plugin manifest once the plugin is off", () => {
  const id = addPlugin('writing')
  library.enable(id, 'claude', true)
  const generated = join(root, 'plugins/runtime/claude/writing')
  expect(existsSync(join(generated, '.claude-plugin/plugin.json'))).toBe(true)
  library.enable(id, 'claude', false)
  expect(existsSync(generated)).toBe(false)
})

describe('external edits', () => {
  it('watches authoring files and schedules refresh only for agents using the changed plugin', async () => {
    const id = addPlugin('writing'); library.enable(id, 'claude', true)
    library.startWatching(); changed.mockClear()
    const file = library.readFile(id, record(id).skills[0].path)
    writeFileSync(join(record(id).directory, file.path), file.content + '\nChanged by an agent\n')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(['claude']), { timeout: 3000 })
  })
})


it('reports unverified direct-only behavior for custom agents', () => {
  const id = addPlugin('writing')
  const path = record(id).skills[0].path
  put(id, path, readFileSync(join(record(id).directory, path), 'utf8').replace('description:', 'disable-model-invocation: true\ndescription:'))
  expect(record(id).agents.find(a => a.id === 'custom:local')?.message).toContain('Configure')
  library.setSkillDirectory('custom:local', join(root, 'custom'))
  expect(record(id).agents.find(a => a.id === 'custom:local')?.message).toContain('unverified')
})


describe('import (phase 2)', () => {
  const settings = (): string => join(root, 'settings.json')
  function withBuiltin(): PluginLibrary { return new PluginLibrary({ directory: join(root, 'plugins'), agents: () => agents, connections: () => connections, busy: id => busy.has(id), changed, settings: settings() }) }
  beforeEach(() => { library.close(); library = withBuiltin() })

  it('delivers the built-in skill to every agent, with no plugin enabled, naming the library and settings', () => {
    library.reconcile()
    const builtin = join(root, 'plugins/runtime/builtin')
    for (const [folder, name] of [['claude/skills', 'new-plugin'], ['codex/.agents/skills', 'gloss-new-plugin'], ['opencode/skills', 'gloss-new-plugin']]) {
      const content = readFileSync(join(builtin, folder, name, 'SKILL.md'), 'utf8')
      expect(content.startsWith(`---\nname: ${name}\n`)).toBe(true)
      expect(content).toContain(library.directory)
      expect(content).toContain(settings())
      expect(content).toContain('`custom:local` (Local agent)')
      // New plugins are on for every agent that can take one; the custom agent has no skill directory.
      expect(content).toContain('set it to `["claude","codex","opencode"]`')
      // Claude Code expands its plugin variables in a plugin skill's text, which would garble the instructions.
      expect(content).not.toContain('${CLAUDE_')
    }
    expect(JSON.parse(readFileSync(join(builtin, 'claude/.claude-plugin/plugin.json'), 'utf8')).name).toBe('gloss')
    expect(library.configureAgent(getAgentConfig('claude')).sessionMeta!('').new).toMatchObject({ claudeCode: { options: { plugins: [{ type: 'local', path: join(builtin, 'claude') }] } } })
    expect(library.configureAgent(getAgentConfig('codex')).sessionMeta!('').new?.additionalRoots).toEqual([join(builtin, 'codex')])
    const opencode = library.configureAgent({ ...getAgentConfig('opencode'), env: { OPENCODE_CONFIG_CONTENT: '{}' } })
    expect(JSON.parse(opencode.env!.OPENCODE_CONFIG_CONTENT).skills).toEqual([join(builtin, 'opencode/skills')])
    expect(library.list().plugins.map(p => p.id)).toEqual(['gloss:builtin'])
    // Enabling a plugin adds its delivery after the built-in one.
    const id = addPlugin('writing'); library.enable(id, 'codex', true)
    expect(library.configureAgent(getAgentConfig('codex')).sessionMeta!('').new?.additionalRoots).toEqual([join(builtin, 'codex'), join(root, 'plugins/runtime/codex')])
  })

  it('lists the built-in plugin read-only and always on, and rewrites a hand edit before an agent starts', () => {
    library.reconcile()
    const builtin = library.list().plugins[0]
    expect(builtin).toMatchObject({ id: 'gloss:builtin', builtin: true, problems: [], skills: [{ id: 'new-plugin', files: ['SKILL.md'] }, { id: 'doctor', files: ['SKILL.md'] }] })
    expect(builtin.skills[0].description).toMatch(/^Create a plugin in Gloss/)
    expect(builtin.skills[1].description).toMatch(/^Work out why a Gloss plugin/)
    const doctor = library.readFile('gloss:builtin', 'skills/doctor/SKILL.md').content
    expect(doctor).toContain(join(root, 'plugins/runtime/delivery.json'))
    expect(doctor).toContain(join(root, 'plugins/state.json'))
    expect(doctor).not.toContain('${CLAUDE_')
    expect(readFileSync(join(root, 'plugins/runtime/builtin/codex/.agents/skills/gloss-doctor/SKILL.md'), 'utf8')).toMatch(/^---\nname: gloss-doctor\n/)
    expect(readFileSync(join(root, 'plugins/runtime/builtin/claude/skills/doctor/SKILL.md'), 'utf8')).toMatch(/^---\nname: doctor\n/)
    expect(builtin.agents.map(a => [a.id, a.status])).toEqual([['claude', 'ready'], ['codex', 'ready'], ['opencode', 'ready'], ['custom:local', 'setup']])
    const file = library.readFile('gloss:builtin', 'skills/new-plugin/SKILL.md')
    expect(file.content).toContain(library.directory)
    expect(() => library.enable('gloss:builtin', 'claude', false)).toThrow(/Invalid plugin identifier/)
    expect(() => library.readFile('gloss:builtin', 'skills/new-plugin/other.md')).toThrow(/Unknown file/)
    const generated = join(root, 'plugins/runtime/builtin/codex/.agents/skills/gloss-new-plugin/SKILL.md')
    writeFileSync(generated, 'Hand edit')
    library.configureAgent(getAgentConfig('codex'))
    expect(readFileSync(generated, 'utf8')).toBe(file.content)
  })

  it("writes it into a custom agent's directory without replacing the user's content, and moves it with the directory", () => {
    const first = join(root, 'custom-a'); const second = join(root, 'custom-b')
    library.setSkillDirectory('custom:local', first)
    expect(readFileSync(join(first, 'gloss-new-plugin/SKILL.md'), 'utf8')).toContain('name: gloss-new-plugin')
    expect(readFileSync(join(first, 'gloss-doctor/SKILL.md'), 'utf8')).toContain('name: gloss-doctor')
    mkdirSync(join(second, 'gloss-new-plugin'), { recursive: true }); writeFileSync(join(second, 'gloss-new-plugin/SKILL.md'), 'Mine')
    library.setSkillDirectory('custom:local', second)
    expect(existsSync(join(first, 'gloss-new-plugin'))).toBe(false)
    expect(existsSync(join(first, 'gloss-doctor'))).toBe(false)
    expect(existsSync(join(second, 'gloss-doctor/SKILL.md'))).toBe(true)
    expect(readFileSync(join(second, 'gloss-new-plugin/SKILL.md'), 'utf8')).toBe('Mine')
    expect(library.list().plugins[0].agents.find(a => a.id === 'custom:local')).toMatchObject({ status: 'error', message: expect.stringMatching(/kept/) })
  })

  it('removes the built-in skill under its earlier names only where Gloss wrote it', () => {
    const builtin = join(root, 'plugins/runtime/builtin')
    const custom = join(root, 'custom'); const mine = join(custom, 'plugins'); const old = join(custom, 'gloss-plugins')
    for (const dir of [join(builtin, 'claude/skills/plugins'), join(builtin, 'codex/.agents/skills/gloss-plugins'), mine, old]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(old, 'SKILL.md'), '---\nname: gloss-plugins\ndescription: Old\n---\n')
    writeFileSync(join(mine, 'SKILL.md'), 'Mine')
    library.setSkillDirectory('custom:local', custom)
    expect(existsSync(join(builtin, 'claude/skills/plugins'))).toBe(false)
    expect(existsSync(join(builtin, 'codex/.agents/skills/gloss-plugins'))).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('Mine')
    expect(existsSync(join(builtin, 'claude/skills/new-plugin/SKILL.md'))).toBe(true)
  })

  it("reserves the built-in plugin's id", () => {
    const folder = join(library.directory, 'gloss'); mkdirSync(join(folder, 'skills/plugins'), { recursive: true })
    writeFileSync(join(folder, 'skills/plugins/SKILL.md'), '---\nname: plugins\ndescription: Clash\n---\n')
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ schemaVersion: 1, name: 'Other gloss', description: '', connections: [], enabledAgents: [] }))
    expect(record('gloss').problems[0]).toMatch(/reserved/)
  })

  it('names a skill <plugin>:<skill> in Claude and <plugin>-<skill> elsewhere, from one plain source', () => {
    const id = addPlugin('git-writing', { skills: { commit: 'Write a commit message' } })
    library.setSkillDirectory('custom:local', join(root, 'custom'))
    for (const agent of ['claude', 'codex', 'opencode', 'custom:local']) library.enable(id, agent, true)
    const runtime = join(root, 'plugins/runtime')
    expect(lstatSync(join(runtime, 'claude/git-writing/skills/commit')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(runtime, 'claude/git-writing/.claude-plugin/plugin.json'), 'utf8')).name).toBe('git-writing')
    const copies = [join(runtime, 'codex/.agents/skills/git-writing-commit'), join(runtime, 'opencode/skills/git-writing-commit'), join(root, 'custom/gloss-git-writing-commit')]
    for (const copy of copies) {
      expect(lstatSync(copy).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: git-writing-commit\ndescription: "Write a commit message"/)
    }
    const source = library.readFile(id, 'skills/commit/SKILL.md')
    expect(source.content).toMatch(/^---\nname: commit\n/)
    put(id, source.path, source.content + '\nKeep the subject short.\n'); library.reconcile()
    for (const copy of copies) {
      const content = readFileSync(join(copy, 'SKILL.md'), 'utf8')
      expect(content).toContain('Keep the subject short.')
      expect(content).toMatch(/^---\nname: git-writing-commit\n/)
    }
    expect(record(id).agents.every(a => a.status === 'ready')).toBe(true)
  })

  it('keeps an earlier prefixed skill name as it is, linked everywhere', () => {
    const id = addPlugin('writing')
    const old = join(record(id).directory, 'skills/writing-review'); mkdirSync(old)
    writeFileSync(join(old, 'SKILL.md'), '---\nname: writing-review\ndescription: Review prose\n---\n')
    library.enable(id, 'codex', true)
    const target = join(root, 'plugins/runtime/codex/.agents/skills/writing-review')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('picks up and deploys a plugin an agent writes straight into the library', async () => {
    library.startWatching(); changed.mockClear()
    const folder = join(library.directory, 'imported')
    mkdirSync(join(folder, 'skills/imported-review/references'), { recursive: true })
    writeFileSync(join(folder, 'skills/imported-review/SKILL.md'), '---\nname: imported-review\ndescription: Review a change.\n---\n\nRead references/list.md.\n')
    writeFileSync(join(folder, 'skills/imported-review/references/list.md'), 'Checklist')
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ schemaVersion: 1, name: 'Imported', description: 'From elsewhere', connections: ['Docs'], enabledAgents: ['codex'] }))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(['codex']), { timeout: 3000 })
    expect(record('imported')).toMatchObject({ problems: [], skills: [{ id: 'imported-review', files: ['SKILL.md', 'references/list.md'] }] })
    expect(record('imported').agents.find(a => a.id === 'codex')!.status).toBe('ready')
    expect(readFileSync(join(root, 'plugins/runtime/codex/.agents/skills/imported-review/references/list.md'), 'utf8')).toBe('Checklist')
  })

})

describe('subagents and hooks', () => {
  const runtime = (...parts: string[]) => join(root, 'plugins/runtime', ...parts)
  /** A plugin, on for every agent, with a subagent and hooks in Gloss's formats. */
  function withParts(hooks: unknown[] = [
    { event: 'beforeTool', matcher: 'shell', command: 'check-shell' },
    { event: 'afterTool', matcher: 'read', command: 'log-read' },
    { event: 'PreCompact', command: 'save', agents: ['claude'] }
  ]): string {
    const id = addPlugin('kit', { enabledAgents: ['claude', 'codex', 'opencode'] })
    const folder = record(id).directory
    mkdirSync(join(folder, 'agents')); mkdirSync(join(folder, 'hooks'))
    writeFileSync(join(folder, 'agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews changes.\ntools: read-only\nmodel:\n  claude: haiku\n---\n\nReview the diff.\n')
    writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ hooks }))
    library.settingsChanged()
    return id
  }

  it('lists a plugin’s subagents and hooks, and shows a malformed one as a problem', () => {
    const id = withParts()
    expect(record(id)).toMatchObject({ problems: [], subagents: [{ id: 'reviewer', description: 'Reviews changes.', tools: 'read-only', models: { claude: 'haiku' }, path: 'agents/reviewer.md' }], hooks: [{ event: 'beforeTool', matcher: 'shell', command: 'check-shell', timeout: 60 }, expect.anything(), expect.anything()] })
    expect(library.readFile(id, 'hooks/hooks.json').content).toContain('check-shell')
    expect(library.readFile(id, 'agents/reviewer.md').content).toContain('Review the diff.')
    writeFileSync(join(record(id).directory, 'agents/reviewer.md'), '---\nname: other\ndescription: x\n---\n\nBody\n')
    expect(record(id).problems).toEqual(['agents/reviewer.md: name must match the file name (reviewer).'])
  })

  it('gives Claude plugin agent and hook files, with an agent-specific hook only for it', () => {
    const id = withParts()
    const meta = library.configureAgent(getAgentConfig('claude')).sessionMeta!('').new
    expect(meta).toMatchObject({ claudeCode: { options: { plugins: [{ type: 'local', path: runtime('claude', id) }] } } })
    expect(readFileSync(runtime('claude', id, 'agents/reviewer.md'), 'utf8')).toBe('---\nname: reviewer\ndescription: "Reviews changes."\ntools: Read, Grep, Glob, WebFetch, WebSearch\nmodel: "haiku"\n---\n\nReview the diff.\n')
    expect(JSON.parse(readFileSync(runtime('claude', id, 'hooks/hooks.json'), 'utf8')).hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check-shell', timeout: 60 }] }],
      PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'log-read', timeout: 60 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'save', timeout: 60 }] }]
    })
    // Turned off: the generated files go with its manifest.
    library.enable(id, 'claude', false)
    expect(existsSync(runtime('claude', id))).toBe(false)
  })

  it('gives Codex hooks and roles through CODEX_CONFIG, merged into the user’s, and trusts its own hooks once', async () => {
    const id = withParts()
    const user = { model: 'gpt-5.5', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, agents: { mine: { description: 'Mine', config_file: '/x.toml' } } }
    const base = { ...getAgentConfig('codex'), env: { ...getAgentConfig('codex').env, CODEX_CONFIG: JSON.stringify(user) } }
    const config = library.configureAgent(base)
    const content = JSON.parse(config.env!.CODEX_CONFIG)
    const role = runtime('codex', 'agents', `${id}-reviewer.toml`)
    expect(content).toEqual({
      model: 'gpt-5.5',
      hooks: { Stop: user.hooks.Stop, PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check-shell', timeout: 60 }] }], state: {} },
      agents: { mine: user.agents.mine, [`${id}-reviewer`]: { description: 'Reviews changes.', config_file: role } }
    })
    expect(readFileSync(role, 'utf8')).toBe('developer_instructions = "Review the diff."\nsandbox_mode = "read-only"\n')
    // Codex lists the hooks as untrusted: Gloss records their hashes and asks for one restart with them.
    const hooks = [
      { key: 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0', currentHash: 'sha256:a', trustStatus: 'untrusted', source: 'sessionFlags' },
      { key: 'C:\\.codex\\hooks.json:stop:0:0', currentHash: 'sha256:b', trustStatus: 'untrusted', source: 'user' }
    ]
    const conn = { extRequest: vi.fn(async () => ({ hooks })) }
    const restarted = await config.afterStart!(conn)
    expect(conn.extRequest).toHaveBeenCalledWith('_codex/hooks/list', expect.objectContaining({ cwd: expect.any(String) }))
    expect(JSON.parse(restarted!.env!.CODEX_CONFIG).hooks.state).toEqual({ 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0': { trusted_hash: 'sha256:a' } })
    // Trusted now, or untrusted with a hash it already passed: no further restart.
    expect(await restarted!.afterStart!({ extRequest: async () => ({ hooks: [{ ...hooks[0], trustStatus: 'trusted' }] }) })).toBeUndefined()
    expect(library.trustCodexHooks([hooks[0]])).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'plugins/state.json'), 'utf8')).codexHookTrust).toEqual({ [hooks[0].key]: 'sha256:a' })
    // Not Gloss's hooks, or none at all: nothing to do after start.
    expect(library.trustCodexHooks([hooks[1]])).toBe(false)
    library.enable(id, 'codex', false)
    expect(library.configureAgent(base).afterStart).toBeUndefined()
    expect(existsSync(role)).toBe(false)
  })

  it('gives OpenCode subagents and a generated hook plugin through OPENCODE_CONFIG_CONTENT', () => {
    const id = withParts()
    const config = library.configureAgent({ ...getAgentConfig('opencode'), env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { mine: { mode: 'primary' } }, plugins: ['team-plugin'] }) } })
    const content = JSON.parse(config.env!.OPENCODE_CONFIG_CONTENT)
    expect(content.agents).toEqual({ mine: { mode: 'primary' }, [`${id}-reviewer`]: { description: 'Reviews changes.', mode: 'subagent', system: 'Review the diff.', permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }] } })
    expect(content.plugins).toEqual(['team-plugin', pathToFileURL(runtime('opencode', 'hooks')).href])
    expect(JSON.parse(readFileSync(runtime('opencode', 'hooks/hooks.json'), 'utf8'))).toEqual([
      { event: 'beforeTool', matcher: '^(?:shell)$', command: 'check-shell', timeout: 60 },
      { event: 'afterTool', matcher: '^(?:read)$', command: 'log-read', timeout: 60 }
    ])
    expect(readFileSync(runtime('opencode', 'hooks/index.js'), 'utf8')).toContain('Generated by Gloss')
  })

  it('records what each agent got and skipped for the doctor, and gives custom agents skills only', () => {
    const id = withParts()
    const report = JSON.parse(readFileSync(runtime('delivery.json'), 'utf8'))
    expect(report.agents.codex.plugins[id]).toMatchObject({
      on: true, delivered: true, skills: [`${id}-instructions`], subagents: [{ name: `${id}-reviewer`, delivered: true }],
      hooks: [
        { event: 'beforeTool', delivered: true, as: { event: 'PreToolUse', matcher: 'Bash' } },
        { event: 'afterTool', delivered: false, reason: 'codex has no read tool.' },
        { event: 'PreCompact', delivered: false, reason: 'Only for claude.' }
      ]
    })
    expect(report.agents.claude.plugins[id].subagents).toEqual([{ name: `${id}:reviewer`, delivered: true }])
    expect(report.agents['custom:local'].plugins[id]).toMatchObject({ on: false, reason: 'Off for this agent.', subagents: [{ delivered: false, reason: 'Custom agents get skills only.' }] })
  })

  it('leaves a busy agent’s generated files alone until it’s idle', () => {
    const id = withParts()
    library.configureAgent(getAgentConfig('claude'))
    const file = runtime('claude', id, 'hooks/hooks.json')
    writeFileSync(join(record(id).directory, 'hooks/hooks.json'), JSON.stringify({ hooks: [{ event: 'stop', command: 'later' }] }))
    busy.add('claude')
    library.configureAgent(getAgentConfig('claude'))
    expect(readFileSync(file, 'utf8')).toContain('check-shell')
    busy.delete('claude')
    library.configureAgent(getAgentConfig('claude'))
    expect(readFileSync(file, 'utf8')).toContain('later')
  })
})
