import { parseDocument } from 'yaml'
import { mcpName } from '../shared/mcp'
import { PLUGIN_ID, type PluginHook, type PluginSubagent } from '../shared/plugins'

/**
 * Subagents and hooks in a plugin (SPEC → Plugins → Subagents and hooks): Gloss's own formats,
 * checked here and translated for each agent at delivery. An agent gets what it supports and
 * nothing else; what it skipped and why is recorded for the doctor skill.
 */

/** The agents that take subagents and hooks. Custom profiles get skills only. */
export const PART_AGENTS = ['claude', 'codex', 'opencode'] as const
export type PartAgent = (typeof PART_AGENTS)[number]
export const isPartAgent = (id: string): id is PartAgent => (PART_AGENTS as readonly string[]).includes(id)

/** Gloss's events, which every agent has, and their names in Claude Code and Codex. */
export const HOOK_EVENTS = { sessionStart: 'SessionStart', userPrompt: 'UserPromptSubmit', beforeTool: 'PreToolUse', afterTool: 'PostToolUse', stop: 'Stop' } as const
export type HookEvent = keyof typeof HOOK_EVENTS
const isHookEvent = (event: string): event is HookEvent => Object.hasOwn(HOOK_EVENTS, event)
/**
 * Native events per agent, usable by a hook that names its agents. Claude's is the Agent SDK's
 * `HOOK_EVENTS` (a test keeps them equal; the SDK is too large to load at startup), Codex's from
 * its hooks documentation. OpenCode's hooks are Gloss's own plugin, so it has none.
 */
export const NATIVE_EVENTS: Record<PartAgent, string[]> = {
  claude: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay'],
  codex: ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionStart', 'SessionEnd'],
  opencode: []
}
/** Tool categories and each agent's tool names for them (a regex, as matchers are). Undefined: the agent has no such tool. */
const CATEGORIES: Record<string, Record<PartAgent, string | undefined>> = {
  shell: { claude: 'Bash', codex: 'Bash', opencode: 'shell' },
  edit: { claude: 'Edit|Write|MultiEdit|NotebookEdit', codex: 'apply_patch|Edit|Write', opencode: 'edit|write|patch' },
  // Codex reads files through its shell.
  read: { claude: 'Read', codex: undefined, opencode: 'read' }
}
const TOOL_EVENTS = new Set(['beforeTool', 'afterTool'])
const DEFAULT_TIMEOUT = 60
const MAX_HOOKS = 100
const MAX_COMMAND = 4000
const HOOK_KEYS = ['event', 'matcher', 'command', 'timeout', 'agents']
const SUBAGENT_KEYS = ['name', 'description', 'tools', 'model']
/** Claude Code's tools that don't change anything, for a read-only subagent. */
const CLAUDE_READ_ONLY_TOOLS = 'Read, Grep, Glob, WebFetch, WebSearch'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A subagent's name outside Claude, which namespaces it as `<plugin-id>:<name>`. Same rule as skills. */
export function flatName(pluginId: string, name: string): string { return name.startsWith(`${pluginId}-`) ? name : `${pluginId}-${name}` }

/** Parses `agents/<name>.md`. Throws a message for the Plugins screen. */
export function parseSubagent(pluginId: string, file: string, raw: string): PluginSubagent & { instructions: string } {
  const id = file.replace(/\.md$/, '')
  const label = `agents/${file}`
  if (!file.endsWith('.md') || !PLUGIN_ID.test(id)) throw new Error(`${label}: each subagent is a .md file with a lowercase name.`)
  if (!PLUGIN_ID.test(flatName(pluginId, id))) throw new Error(`${label}: the plugin id and subagent name together must fit within 64 characters.`)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${label}: needs frontmatter with name and description.`)
  const doc = parseDocument(match[1])
  const data: unknown = doc.errors.length ? undefined : doc.toJS()
  if (!object(data)) throw new Error(`${label}: its frontmatter isn't valid YAML.`)
  const unknown = Object.keys(data).find(k => !SUBAGENT_KEYS.includes(k))
  if (unknown) throw new Error(`${label}: unsupported field ${unknown}. Subagents take name, description, tools and model.`)
  if (data.name !== id) throw new Error(`${label}: name must match the file name (${id}).`)
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.includes('\n')) throw new Error(`${label}: needs a single-line description.`)
  if (data.tools !== undefined && data.tools !== 'read-only' && data.tools !== 'inherit') throw new Error(`${label}: tools is read-only or inherit.`)
  const models: Partial<Record<PartAgent, string>> = {}
  if (data.model !== undefined) {
    if (!object(data.model)) throw new Error(`${label}: model lists a model per agent, for example claude: haiku.`)
    for (const [agent, model] of Object.entries(data.model)) {
      if (!isPartAgent(agent)) throw new Error(`${label}: model names an unknown agent ${agent}. Use ${PART_AGENTS.join(', ')}.`)
      if (typeof model !== 'string' || !model.trim()) throw new Error(`${label}: the ${agent} model must be text.`)
      models[agent] = model.trim()
    }
  }
  const instructions = match[2].trim()
  if (!instructions) throw new Error(`${label}: write the subagent's instructions below its frontmatter.`)
  return { id, description: data.description.trim(), tools: data.tools === 'read-only' ? 'read-only' : 'inherit', models, path: label, instructions }
}

/** Parses `hooks/hooks.json`. Throws a message for the Plugins screen. */
export function parseHooks(raw: string): PluginHook[] {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('hooks/hooks.json isn’t valid JSON.') }
  if (!object(value) || Object.keys(value).some(k => k !== 'hooks') || !Array.isArray(value.hooks)) throw new Error('hooks/hooks.json must be { "hooks": [ ... ] } in Gloss’s hook format.')
  if (value.hooks.length > MAX_HOOKS) throw new Error(`A plugin can have at most ${MAX_HOOKS} hooks.`)
  return value.hooks.map((item: unknown, i: number): PluginHook => {
    const label = `Hook ${i + 1}`
    if (!object(item)) throw new Error(`${label}: expected an object with event and command.`)
    const unknown = Object.keys(item).find(k => !HOOK_KEYS.includes(k))
    if (unknown) throw new Error(`${label}: unsupported field ${unknown}. Hooks take event, matcher, command, timeout and agents.`)
    const { event, matcher, command, timeout, agents } = item
    if (agents !== undefined && (!Array.isArray(agents) || !agents.length || !agents.every(a => typeof a === 'string' && isPartAgent(a)))) throw new Error(`${label}: agents lists one or more of ${PART_AGENTS.join(', ')}.`)
    const only = agents as PartAgent[] | undefined
    if (typeof event !== 'string' || !event) throw new Error(`${label}: event is required.`)
    if (!isHookEvent(event)) {
      if (!only) throw new Error(`${label}: ${event} isn’t one of Gloss’s events (${Object.keys(HOOK_EVENTS).join(', ')}). An agent’s own event needs agents.`)
      const missing = only.find(a => !NATIVE_EVENTS[a].includes(event))
      if (missing) throw new Error(`${label}: ${missing === 'opencode' ? 'OpenCode only has Gloss’s events' : `${event} isn’t a ${missing} event`}.`)
    }
    if (matcher !== undefined) {
      if (typeof matcher !== 'string' || !matcher.trim()) throw new Error(`${label}: matcher must be text.`)
      if (isHookEvent(event) && !TOOL_EVENTS.has(event)) throw new Error(`${label}: only beforeTool and afterTool take a matcher.`)
      if (!category(matcher) && !only) throw new Error(`${label}: matcher is shell, edit, read, any or mcp:<server>. An agent’s own tool names need agents.`)
    }
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND || command.includes('\0')) throw new Error(`${label}: command is required (up to ${MAX_COMMAND} characters).`)
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) throw new Error(`${label}: timeout is whole seconds from 1 to 3600.`)
    return { event, ...(matcher !== undefined ? { matcher: (matcher as string).trim() } : {}), command, timeout: (timeout as number | undefined) ?? DEFAULT_TIMEOUT, ...(only ? { agents: only } : {}) }
  })
}

function category(matcher: string): boolean { return matcher === 'any' || Object.hasOwn(CATEGORIES, matcher) || /^mcp:.+/.test(matcher) }

/** A hook as one agent gets it, or why it doesn't. `matcher` undefined matches every tool. */
export type HookPlan = { delivered: true; event: string; matcher?: string; command: string; timeout: number } | { delivered: false; reason: string }

export function planHook(hook: PluginHook, agent: PartAgent): HookPlan {
  if (hook.agents && !hook.agents.includes(agent)) return { delivered: false, reason: `Only for ${hook.agents.join(', ')}.` }
  const event = isHookEvent(hook.event) ? (agent === 'opencode' ? hook.event : HOOK_EVENTS[hook.event]) : hook.event
  let matcher: string | undefined
  if (hook.matcher && hook.matcher !== 'any') {
    if (Object.hasOwn(CATEGORIES, hook.matcher)) {
      matcher = CATEGORIES[hook.matcher][agent]
      if (!matcher) return { delivered: false, reason: `${agent} has no ${hook.matcher} tool.` }
    } else if (hook.matcher.startsWith('mcp:')) {
      // Agents replace characters a tool name can't hold; `.` stands for any of them.
      const server = mcpName(hook.matcher.slice(4)).split('').map(c => /[A-Za-z0-9_-]/.test(c) ? c : '.').join('')
      matcher = agent === 'opencode' ? `${server}_.*` : `mcp__${server}__.*`
    } else matcher = hook.matcher
  }
  return { delivered: true, event, ...(matcher ? { matcher } : {}), command: hook.command, timeout: hook.timeout }
}

type NativeHooks = Record<string, { matcher?: string; hooks: { type: 'command'; command: string; timeout: number }[] }[]>
/** Claude Code's and Codex's hook configuration (the same shape), one group per hook. */
export function nativeHooks(hooks: PluginHook[], agent: 'claude' | 'codex'): NativeHooks {
  const out: NativeHooks = {}
  for (const hook of hooks) {
    const plan = planHook(hook, agent)
    if (!plan.delivered) continue
    ;(out[plan.event] ??= []).push({ ...(plan.matcher ? { matcher: plan.matcher } : {}), hooks: [{ type: 'command', command: plan.command, timeout: plan.timeout }] })
  }
  return out
}

/** What Gloss's OpenCode hook plugin runs: Gloss event names and anchored tool-name regexes. */
export function openCodeHooks(hooks: PluginHook[]): { event: HookEvent; matcher?: string; command: string; timeout: number }[] {
  return hooks.flatMap(hook => {
    const plan = planHook(hook, 'opencode')
    if (!plan.delivered || !isHookEvent(plan.event)) return []
    return [{ event: plan.event, ...(plan.matcher ? { matcher: `^(?:${plan.matcher})$` } : {}), command: plan.command, timeout: plan.timeout }]
  })
}

type Subagent = PluginSubagent & { instructions: string }
/** A subagent as a Claude Code plugin agent file. */
export function claudeSubagent(agent: Subagent): string {
  const lines = [`name: ${agent.id}`, `description: ${JSON.stringify(agent.description)}`]
  if (agent.tools === 'read-only') lines.push(`tools: ${CLAUDE_READ_ONLY_TOOLS}`)
  if (agent.models.claude) lines.push(`model: ${JSON.stringify(agent.models.claude)}`)
  return `---\n${lines.join('\n')}\n---\n\n${agent.instructions}\n`
}
/** A subagent as a Codex role file (its `config_file`). JSON strings are valid TOML basic strings. */
export function codexRole(agent: Subagent): string {
  const lines = [`developer_instructions = ${JSON.stringify(agent.instructions)}`]
  if (agent.models.codex) lines.push(`model = ${JSON.stringify(agent.models.codex)}`)
  if (agent.tools === 'read-only') lines.push('sandbox_mode = "read-only"')
  return lines.join('\n') + '\n'
}
/** A subagent as an OpenCode v2 `agents` entry. */
export function openCodeSubagent(agent: Subagent): Record<string, unknown> {
  return {
    description: agent.description,
    mode: 'subagent',
    system: agent.instructions,
    ...(agent.models.opencode ? { model: agent.models.opencode } : {}),
    ...(agent.tools === 'read-only' ? { permissions: ['edit', 'shell'].map(action => ({ action, resource: '*', effect: 'deny' })) } : {})
  }
}

/**
 * Gloss's OpenCode plugin, which runs the hooks listed in `hooks.json` beside it. OpenCode has no
 * command hooks, so this defines what a command gets: Claude Code's payload shape (event names
 * included) with OpenCode's own tool names. Exit code 2 (stderr as the reason), or stdout
 * `{"decision":"block","reason":...}` or a `permissionDecision` of `deny`, blocks a tool or prompt.
 */
export const OPENCODE_HOOK_PLUGIN = `// Generated by Gloss. Runs the hooks of Gloss plugins; edits here are overwritten.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const hooks = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'))
const NAMES = ${JSON.stringify(HOOK_EVENTS)}

/** Stops the command and what its shell started: killing the shell alone leaves those running on Windows. */
function stop(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
  else child.kill('SIGKILL')
}

function run(hook, payload, cwd) {
  return new Promise((done) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const resolve = (result) => { if (!settled) { settled = true; clearTimeout(timer); done(result) } }
    let child
    try { child = spawn(hook.command, { shell: true, cwd, windowsHide: true }) } catch (error) { done({ blocked: false }); return }
    // A hook that runs too long is stopped and doesn't block.
    const timer = setTimeout(() => { stop(child); resolve({ blocked: false }) }, hook.timeout * 1000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', () => resolve({ blocked: false }))
    child.on('close', (code) => {
      if (code === 2) { resolve({ blocked: true, reason: stderr.trim() }); return }
      try {
        const out = JSON.parse(stdout)
        const specific = out && out.hookSpecificOutput
        if (out && out.decision === 'block') { resolve({ blocked: true, reason: out.reason }); return }
        if (specific && specific.permissionDecision === 'deny') { resolve({ blocked: true, reason: specific.permissionDecisionReason }); return }
      } catch {}
      resolve({ blocked: false })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

export default {
  id: 'gloss-hooks',
  async setup(ctx) {
    const cwd = (ctx.location && ctx.location.directory) || process.cwd()
    const fire = async (event, payload, tool) => {
      for (const hook of hooks) {
        if (hook.event !== event || (hook.matcher && !new RegExp(hook.matcher).test(tool ?? ''))) continue
        const result = await run(hook, { hook_event_name: NAMES[event], cwd, ...payload }, cwd)
        if (result.blocked) return result
      }
      return undefined
    }
    await ctx.tool.hook('execute.before', async (e) => {
      const result = await fire('beforeTool', { session_id: e.sessionID, tool_name: e.tool, tool_input: e.input }, e.tool)
      if (result) throw new Error(result.reason || 'Blocked by a hook.')
    })
    await ctx.tool.hook('execute.after', async (e) => {
      await fire('afterTool', { session_id: e.sessionID, tool_name: e.tool, tool_input: e.input, tool_response: e.result }, e.tool)
    })
    await ctx.session.hook('prompt', async (e) => {
      const result = await fire('userPrompt', { session_id: e.sessionID, prompt: e.prompt && e.prompt.text })
      if (result) throw new Error(result.reason || 'Blocked by a hook.')
    })
    void (async () => {
      for await (const e of ctx.event.subscribe()) {
        const session = e.data && (e.data.sessionID || e.data.id)
        if (e.type === 'session.created') void fire('sessionStart', { session_id: session, source: 'startup' })
        else if (e.type === 'session.execution.succeeded') void fire('stop', { session_id: session })
      }
    })().catch(() => {})
  }
}
`
