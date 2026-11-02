// Opt in with GLOSS_PLUGIN_PARTS_LIVE=1. Delivers a plugin's subagent and hooks through PluginLibrary to the
// real adapters and real models (SPEC → Plugins → Subagents and hooks): Claude with the signed-in account and
// Haiku, Codex with a scratch CODEX_HOME holding a copy of ~/.codex/auth.json, OpenCode (GLOSS_OPENCODE_EXECUTABLE)
// with isolated folders and a free OpenCode model. The scratch folders are removed afterwards.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentConnection, type AgentHandlers } from './acp'
import { agentEnv, getAgentConfig, type AgentConfig } from './agents'
import { OpenCodeSupport } from './opencode'
import { PluginLibrary } from './plugins'

const SECRET = 'PERIWINKLE-42'
const live = !!process.env.GLOSS_PLUGIN_PARTS_LIVE

it.skipIf(!live)('imports a Claude Code plugin’s subagent and hooks into Gloss’s formats through the new-plugin skill (Claude, Haiku)', { timeout: 300000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gloss-parts-import-'))
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid test cleanup path.')
  const cwd = join(root, 'project'); mkdirSync(cwd)
  // A Claude Code plugin in its own formats.
  const source = join(root, 'source')
  for (const dir of ['.claude-plugin', 'agents', 'hooks', 'skills/lint']) mkdirSync(join(source, dir), { recursive: true })
  writeFileSync(join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'guard', description: 'Guards shell commands.' }))
  writeFileSync(join(source, 'skills/lint/SKILL.md'), '---\nname: lint\ndescription: Lint the project.\n---\n\nRun the linter.\n')
  writeFileSync(join(source, 'agents/auditor.md'), '---\nname: auditor\ndescription: Audits changes for risky commands.\ntools: Read, Grep, Glob\ncolor: red\n---\n\nAudit the recent changes.\n')
  writeFileSync(join(source, 'hooks/hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check.js"' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/save.js"' }] }]
  } }))
  writeFileSync(join(source, 'hooks/check.js'), 'process.exit(0)\n')
  writeFileSync(join(source, 'hooks/save.js'), 'process.exit(0)\n')
  const settings = join(root, 'settings.json'); writeFileSync(settings, JSON.stringify({ mcpServers: [] }))
  const library = new PluginLibrary({ directory: join(root, 'plugins'), agents: () => [{ id: 'claude', name: 'Claude Code' }], connections: () => [], settings })
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE')), ANTHROPIC_MODEL: 'haiku' }
  const config = library.configureAgent(getAgentConfig('claude'))
  const conn = await AgentConnection.start(config, agentEnv(config, env), {
    onUpdate: () => {}, onStderr: () => {}, onClosed: () => {},
    onPermission: async (req) => ({ outcome: { outcome: 'selected', optionId: req.options.find(o => o.kind.startsWith('allow'))?.optionId ?? req.options[0].optionId } })
  })
  try {
    const session = await conn.newSession(cwd, config.sessionMeta?.('').new)
    if (config.bypassModeId) await conn.setMode(session.sessionId, config.bypassModeId)
    await conn.prompt(session.sessionId, [{ type: 'text', text: `Use the gloss:new-plugin skill to import the Claude Code plugin at ${source.replaceAll('\\', '/')} into Gloss. Don't ask me anything; follow the skill's rules.` }])
    const plugin = library.list().plugins.find(p => !p.builtin)
    expect(plugin, 'an imported plugin').toBeTruthy()
    expect(plugin!.problems).toEqual([])
    expect(plugin!.enabledAgents).toEqual([])
    expect(plugin!.skills.map(s => s.id)).toEqual(['lint'])
    expect(plugin!.subagents).toMatchObject([{ id: 'auditor', tools: 'read-only' }])
    expect(plugin!.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'beforeTool', matcher: 'shell', command: expect.stringContaining(`${plugin!.directory.replaceAll('\\', '/')}/hooks/check.js`) }),
      expect.objectContaining({ event: 'PreCompact', agents: ['claude'] })
    ]))
  } finally {
    conn.dispose()
    library.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
})

it.skipIf(!live).for(['claude', 'codex', 'opencode'])('delivers a subagent and hooks to %s, and its hooks run and block', { timeout: 300000 }, async (agentId, context) => {
  if (agentId === 'opencode' && !process.env.GLOSS_OPENCODE_EXECUTABLE) { context.skip(); return }
  const root = mkdtempSync(join(tmpdir(), 'gloss-parts-live-'))
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid test cleanup path.')
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const log = join(root, 'hooks.log')
  const script = join(root, 'hook.mjs')
  writeFileSync(script, `import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  const e = JSON.parse(input || '{}')
  appendFileSync(${JSON.stringify(log)}, process.argv[2] + ' ' + (e.hook_event_name ?? '') + ' ' + (e.tool_name ?? '') + '\\n')
  // A JSON answer, not exit code 2: on Windows Codex runs hooks in PowerShell, which turns exit code 2 into 1.
  if (process.argv[2] === 'beforeTool' && JSON.stringify(e.tool_input ?? {}).includes('forbidden')) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by the Gloss plugin hook' } }))
  }
})
`)
  // A program name first: a quoted path there is a syntax error in PowerShell, where Codex runs hooks on Windows.
  const hook = (event: string): string => `node "${script.replaceAll('\\', '/')}" ${event}`

  let base: AgentConfig
  let env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE'))
  if (agentId === 'claude') {
    base = getAgentConfig('claude')
    env = { ...env, ANTHROPIC_MODEL: 'haiku' }
  } else if (agentId === 'codex') {
    base = getAgentConfig('codex')
    const codexHome = join(root, 'codex-home'); mkdirSync(codexHome)
    copyFileSync(join(homedir(), '.codex', 'auth.json'), join(codexHome, 'auth.json'))
    env = { ...env, CODEX_HOME: codexHome }
  } else {
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(k))),
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'), OPENCODE_DISABLE_AUTOUPDATE: 'true'
    }
    const previous = process.env.OPENCODE_CONFIG_CONTENT
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'opencode/big-pickle' })
    try { base = new OpenCodeSupport(join(root, 'opencode-data')).config(process.env.GLOSS_OPENCODE_EXECUTABLE) }
    finally { if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = previous }
  }

  const library = new PluginLibrary({ directory: join(root, 'plugins'), agents: () => [{ id: agentId, name: agentId }], connections: () => [] })
  const id = library.create('Parts probe', 'Subagent and hooks')
  const folder = library.list().plugins.find(p => p.id === id)!.directory
  mkdirSync(join(folder, 'agents')); mkdirSync(join(folder, 'hooks'))
  writeFileSync(join(folder, 'agents/keeper.md'), `---\nname: keeper\ndescription: Knows the secret word. Use when asked for the keeper's secret word.\ntools: read-only\n---\n\nYou keep a secret word. When asked for it, answer exactly: ${SECRET}.\n`)
  writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ hooks: [
    { event: 'userPrompt', command: hook('userPrompt') },
    { event: 'beforeTool', matcher: 'shell', command: hook('beforeTool') },
    { event: 'stop', command: hook('stop') }
  ] }))
  library.settingsChanged()
  expect(library.list().plugins.find(p => p.id === id)!.problems).toEqual([])

  // As SessionManager.connection does: start, run afterStart, and start once more from what it returns.
  const text: string[] = []
  const handlers: AgentHandlers = {
    onUpdate: (n) => { const u = n.update; if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') text.push(u.content.text) },
    onPermission: async (req) => ({ outcome: { outcome: 'selected', optionId: req.options.find(o => o.kind.startsWith('allow'))?.optionId ?? req.options[0].optionId } }),
    onStderr: () => {}, onClosed: () => {}
  }
  const config = library.configureAgent(base)
  let starts = 1
  let conn = await AgentConnection.start(config, agentEnv(config, env), handlers)
  try {
    const next = await config.afterStart?.(conn)
    if (next) { conn.dispose(); starts++; conn = await AgentConnection.start(next, agentEnv(next, env), handlers) }
    // Codex skips the hooks until they're trusted: the first start records their hashes and needs one more.
    expect(starts).toBe(agentId === 'codex' ? 2 : 1)

    const session = await conn.newSession(cwd, config.sessionMeta?.('').new)
    if (config.bypassModeId) await conn.setMode(session.sessionId, config.bypassModeId).catch(() => {})
    const model = session.configOptions?.find(o => o.category === 'model')
    const cheap = model?.type === 'select' ? model.options.flatMap(o => 'options' in o ? o.options : [o]).find(o => /luna|mini/i.test(o.value)) : undefined
    if (agentId === 'codex' && model && cheap) await conn.setConfigOption(session.sessionId, model.id, cheap.value)
    const ask = async (prompt: string): Promise<string> => {
      text.length = 0
      await conn.prompt(session.sessionId, [{ type: 'text', text: prompt }])
      return text.join('')
    }

    const blocked = await ask('Run the shell command `echo forbidden` with your shell tool and tell me exactly what happened. Do not try another way.')
    const hooks = existsSync(log) ? readFileSync(log, 'utf8') : ''
    expect(hooks).toMatch(/^userPrompt /m)
    expect(hooks).toMatch(/^beforeTool /m)
    // OpenCode's turn-end hook runs from its event stream, just after the prompt's response.
    await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toMatch(/^stop /m), { timeout: 15000 })
    expect(blocked).toMatch(/block|hook|denied|prevent/i)

    const answer = await ask(`Use the ${agentId === 'claude' ? `${id}:keeper` : `${id}-keeper`} subagent and ask it for its secret word. ${agentId === 'claude' ? 'Run it in the foreground and wait for its reply. ' : ''}Report exactly what it answered. Do not guess.`)
    expect(answer).toContain(SECRET)
  } finally {
    conn.dispose()
    library.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
})
