import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
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

it('creates ordinary editable packages, isolates names, and persists without enabling agents', () => {
  const id = library.create('Writing', 'My writing preferences')
  const second = library.create('Code review', 'Review changes')
  expect(record(id)).toMatchObject({ id: 'writing', name: 'Writing', enabledAgents: [] })
  expect(record(id).skills[0]).toMatchObject({ id: 'writing-instructions', name: 'instructions' })
  expect(record(second).skills[0].id).not.toBe(record(id).skills[0].id)
  expect(changed.mock.calls.every(([ids]) => ids.length === 0)).toBe(true)
  library = make()
  expect(library.list().plugins).toHaveLength(2)
  expect(() => library.create('writing', '')).toThrow(/already exists/)
})

it('shares source files through native projections and never touches native user skill folders', () => {
  const id = library.create('Review', 'Review changes')
  const skill = record(id).skills[0]
  library.createFile(id, skill.id, 'references/checklist.md', 'First checklist')
  for (const agent of ['claude', 'codex', 'opencode']) library.enable(id, agent, true)
  const targets = deployments()
  expect(targets).toHaveLength(3)
  for (const target of targets) {
    expect(target.target.startsWith(join(root, 'plugins/runtime'))).toBe(true)
    expect(lstatSync(target.target).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(target.target, 'references/checklist.md'), 'utf8')).toBe('First checklist')
  }
  const file = library.readFile(id, `skills/${skill.id}/references/checklist.md`)
  library.writeFile(id, { ...file, content: 'Updated checklist' })
  for (const target of targets) expect(readFileSync(join(target.target, 'references/checklist.md'), 'utf8')).toBe('Updated checklist')
  library.enable(id, 'codex', false)
  expect(deployments()).toHaveLength(2)
  expect(existsSync(record(id).directory)).toBe(true)
  expect(record(id).agents.find(a => a.id === 'claude')!.enabled).toBe(true)
})

it('preserves adapter instructions and native OpenCode settings when adding plugin delivery', () => {
  const id = library.create('Writing', 'Write clearly')
  for (const agent of ['claude', 'codex', 'opencode']) library.enable(id, agent, true)
  const claude = library.configureAgent(getAgentConfig('claude')).sessionMeta!('thread guidance')
  expect(claude.new).toMatchObject({ systemPrompt: { append: 'thread guidance' }, claudeCode: { options: { plugins: [{ type: 'local', path: join(root, 'plugins/runtime/claude/writing') }] } } })
  expect(claude.load).toEqual(claude.new)
  const codex = library.configureAgent(getAgentConfig('codex')).sessionMeta!('thread guidance')
  expect(codex.new).toMatchObject({ jetbrains: { air: { customInstructions: 'thread guidance' } }, additionalRoots: [join(root, 'plugins/runtime/codex')] })
  const config = library.configureAgent({ ...getAgentConfig('opencode'), env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['native.md'], skills: ['team-skills'], providers: { local: { model: 'test' } } }) } })
  expect(JSON.parse(config.env!.OPENCODE_CONFIG_CONTENT)).toEqual({ instructions: ['native.md'], skills: ['team-skills', join(root, 'plugins/runtime/opencode/skills')], providers: { local: { model: 'test' } } })
  library.enable(id, 'codex', false)
  expect(library.configureAgent(getAgentConfig('codex')).sessionMeta!('').new!.additionalRoots).toEqual([])
})

it('requires custom agent configuration and refuses pre-existing deployment content', () => {
  const id = library.create('Writing', 'Write clearly')
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
  const id = library.create('Writing', 'Write clearly')
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

it('blocks overwriting edits made outside the UI, even when they changed only supporting files', () => {
  const id = library.create('Writing', 'Write clearly')
  const path = record(id).skills[0].path
  const original = library.readFile(id, path)
  writeFileSync(join(record(id).directory, path), original.content + '\nExternal edit\n')
  expect(() => library.writeFile(id, { ...original, content: 'Overwrite' })).toThrow(/changed outside/)
  expect(library.readFile(id, path).content).toContain('External edit')
})

it('rejects traversal and symlink escapes when reading or editing files', () => {
  const id = library.create('Writing', 'Write clearly')
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'Keep me')
  for (const path of ['../outside/secret.txt', 'skills/../../outside/secret.txt', 'skills/x/C:/secret', 'skills\\x\\secret']) expect(() => library.readFile(id, path)).toThrow()
  const linked = join(record(id).directory, 'skills', record(id).skills[0].id, 'linked')
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => library.readFile(id, `skills/writing-instructions/linked/secret.txt`)).toThrow(/Linked files/)
  expect(() => library.createFile(id, 'writing-instructions', 'linked/new.txt', 'x')).toThrow()
  expect(existsSync(join(outside, 'new.txt'))).toBe(false)
})

it('tracks copy fallback updates and preserves diverged deployment files', () => {
  library = make(true)
  const id = library.create('Writing', 'Write clearly')
  library.enable(id, 'codex', true)
  const d = deployments()[0]
  expect(d.mode).toBe('copy')
  const file = library.readFile(id, record(id).skills[0].path)
  library.writeFile(id, { ...file, content: file.content + '\nNew instruction\n' })
  expect(readFileSync(join(d.target, 'SKILL.md'), 'utf8')).toContain('New instruction')
  writeFileSync(join(d.target, 'notes.txt'), 'Deployment edit')
  expect(() => library.enable(id, 'codex', false)).toThrow(/local edits/)
  expect(() => library.remove(id)).toThrow(/local edits/)
  expect(readFileSync(join(d.target, 'notes.txt'), 'utf8')).toBe('Deployment edit')
  expect(existsSync(record(id).directory)).toBe(true)
})

it('does not remove a directory that replaced a managed link', () => {
  const id = library.create('Writing', 'Write clearly'); library.enable(id, 'codex', true)
  const target = deployments()[0].target
  rmSync(target); mkdirSync(target); writeFileSync(join(target, 'user.txt'), 'Unrelated files')
  expect(() => library.remove(id)).toThrow(/replaced outside/)
  expect(readFileSync(join(target, 'user.txt'), 'utf8')).toBe('Unrelated files')
})

it('reports missing deployments on read and safely clears its own dangling links', () => {
  const id = library.create('Writing', 'Write clearly'); library.enable(id, 'codex', true)
  const d = deployments()[0]
  rmSync(d.target)
  expect(record(id).agents.find(a => a.id === 'codex')!.status).toBe('error')
  library.reconcile()
  expect(existsSync(d.target)).toBe(true)
  rmSync(d.source, { recursive: true })
  library.reconcile()
  expect(deployments()).toHaveLength(0)
})

it('refuses a tampered deployment registry pointing at an unrelated folder', () => {
  const id = library.create('Writing', 'Write clearly'); library.enable(id, 'codex', true)
  const unrelated = join(root, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'Keep me')
  const path = join(root, 'plugins/state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  state.deployments[0].target = unrelated
  writeFileSync(path, JSON.stringify(state))
  library = make()
  expect(library.list().errors).toHaveLength(1)
  expect(() => library.remove(id)).toThrow(/deployment state/)
  expect(readFileSync(join(unrelated, 'keep'), 'utf8')).toBe('Keep me')
})

it('keeps active deployments until the turn ends and refuses source removal while busy', () => {
  const id = library.create('Writing', 'Write clearly'); library.enable(id, 'codex', true)
  const target = deployments()[0].target
  busy.add('codex'); library.enable(id, 'codex', false); library.markPending(['codex'])
  expect(existsSync(target)).toBe(true)
  expect(record(id).agents.find(a => a.id === 'codex')).toMatchObject({ enabled: false, status: 'pending' })
  expect(() => library.remove(id)).toThrow(/finish their turns/)
  busy.clear(); library.reconcile(); library.refreshed('codex')
  expect(existsSync(target)).toBe(false)
  expect(record(id).agents.find(a => a.id === 'codex')!.status).toBe('off')
})

it('keeps global MCP definitions independent and reports missing or unsupported requirements', () => {
  const id = library.create('Review', 'Review PRs')
  library.update(id, { connections: ['Docs'] }); library.enable(id, 'codex', true)
  library.remove(id); expect(connections).toHaveLength(1)
  const other = library.create('Other', 'Other workflow')
  library.update(other, { connections: ['Missing'] })
  expect(() => library.enable(other, 'claude', true)).toThrow(/Configure the Missing/)
  connections = [{ name: 'Events', type: 'sse', url: 'https://example.test/sse', headers: [] }]
  library.update(other, { connections: ['Events'] })
  expect(() => library.enable(other, 'codex', true)).toThrow(/SSE/)
})

it('rejects native executable components and malformed deployment state without overwriting them', () => {
  const id = library.create('Writing', 'Write clearly')
  mkdirSync(join(record(id).directory, 'hooks'))
  writeFileSync(join(record(id).directory, 'hooks/hooks.json'), '{}')
  expect(() => library.enable(id, 'claude', true)).toThrow(/not loaded in phase 1/)
  const state = join(root, 'plugins/state.json'); writeFileSync(state, '{broken')
  library = make()
  expect(library.list().errors).toHaveLength(1)
  expect(() => library.enable(id, 'codex', true)).toThrow(/deployment state/)
  expect(readFileSync(state, 'utf8')).toBe('{broken')
})

describe('external edits', () => {
  it('watches authoring files and schedules refresh only for agents using the changed plugin', async () => {
    const id = library.create('Writing', 'Write clearly'); library.enable(id, 'claude', true)
    library.startWatching(); changed.mockClear()
    const file = library.readFile(id, record(id).skills[0].path)
    writeFileSync(join(record(id).directory, file.path), file.content + '\nChanged by an agent\n')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(['claude']), { timeout: 3000 })
  })
})
