import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NATIVE_EVENTS, OPENCODE_HOOK_PLUGIN, claudeSubagent, codexRole, nativeHooks, openCodeHooks, openCodeSubagent, parseHooks, parseSubagent, planHook } from './pluginParts'

const agentFile = (front: string, body = 'Review the diff.'): string => `---\n${front}\n---\n\n${body}\n`

describe('parseSubagent', () => {
  it('reads name, description, tools and per-agent models', () => {
    const agent = parseSubagent('kit', 'reviewer.md', agentFile('name: reviewer\ndescription: Reviews changes.\ntools: read-only\nmodel:\n  claude: haiku\n  codex: gpt-5.5'))
    expect(agent).toEqual({ id: 'reviewer', description: 'Reviews changes.', tools: 'read-only', models: { claude: 'haiku', codex: 'gpt-5.5' }, path: 'agents/reviewer.md', instructions: 'Review the diff.' })
    expect(parseSubagent('kit', 'reviewer.md', agentFile('name: reviewer\ndescription: x')).tools).toBe('inherit')
  })

  it('refuses what it would have to guess at', () => {
    const bad = (file: string, raw: string) => () => parseSubagent('kit', file, raw)
    expect(bad('Reviewer.md', agentFile('name: Reviewer\ndescription: x'))).toThrow(/lowercase/)
    expect(bad('reviewer.md', agentFile('name: other\ndescription: x'))).toThrow(/match the file name/)
    expect(bad('reviewer.md', agentFile('name: reviewer'))).toThrow(/description/)
    expect(bad('reviewer.md', agentFile('name: reviewer\ndescription: x\ntools: Read, Grep'))).toThrow(/read-only or inherit/)
    expect(bad('reviewer.md', agentFile('name: reviewer\ndescription: x\ncolor: blue'))).toThrow(/unsupported field color/)
    expect(bad('reviewer.md', agentFile('name: reviewer\ndescription: x\nmodel: haiku'))).toThrow(/per agent/)
    expect(bad('reviewer.md', agentFile('name: reviewer\ndescription: x\nmodel:\n  gemini: pro'))).toThrow(/unknown agent gemini/)
    expect(bad('reviewer.md', agentFile('name: reviewer\ndescription: x', ''))).toThrow(/instructions/)
    expect(bad('reviewer.md', 'no frontmatter')).toThrow(/frontmatter/)
  })

  it('translates for each agent', () => {
    const agent = parseSubagent('kit', 'reviewer.md', agentFile('name: reviewer\ndescription: Reviews "changes".\ntools: read-only\nmodel:\n  claude: haiku\n  codex: gpt-5.5\n  opencode: opencode/big-pickle', 'Line one.\nSay "hi".'))
    expect(claudeSubagent(agent)).toBe('---\nname: reviewer\ndescription: "Reviews \\"changes\\"."\ntools: Read, Grep, Glob, WebFetch, WebSearch\nmodel: "haiku"\n---\n\nLine one.\nSay "hi".\n')
    expect(codexRole(agent)).toBe('developer_instructions = "Line one.\\nSay \\"hi\\"."\nmodel = "gpt-5.5"\nsandbox_mode = "read-only"\n')
    expect(openCodeSubagent(agent)).toEqual({
      description: 'Reviews "changes".', mode: 'subagent', system: 'Line one.\nSay "hi".', model: 'opencode/big-pickle',
      permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }]
    })
    const plain = parseSubagent('kit', 'helper.md', agentFile('name: helper\ndescription: Helps.'))
    expect(claudeSubagent(plain)).not.toMatch(/tools:|model:/)
    expect(codexRole(plain)).toBe('developer_instructions = "Review the diff."\n')
    expect(openCodeSubagent(plain)).toEqual({ description: 'Helps.', mode: 'subagent', system: 'Review the diff.' })
  })
})

describe('parseHooks', () => {
  const hooks = (list: unknown[]): string => JSON.stringify({ hooks: list })

  it('reads hooks with a default timeout', () => {
    expect(parseHooks(hooks([{ event: 'beforeTool', matcher: 'shell', command: 'check' }, { event: 'PreCompact', command: 'save', timeout: 5, agents: ['claude'] }]))).toEqual([
      { event: 'beforeTool', matcher: 'shell', command: 'check', timeout: 60 },
      { event: 'PreCompact', command: 'save', timeout: 5, agents: ['claude'] }
    ])
  })

  it('refuses invalid hooks', () => {
    const bad = (list: unknown[]) => () => parseHooks(hooks(list))
    expect(() => parseHooks('{')).toThrow(/valid JSON/)
    expect(() => parseHooks('{"hooks":{}}')).toThrow(/Gloss’s hook format/)
    // A Claude Code plugin's own hooks.json isn't Gloss's format.
    expect(() => parseHooks(JSON.stringify({ hooks: { PreToolUse: [] } }))).toThrow(/Gloss’s hook format/)
    expect(bad([{ event: 'PreCompact', command: 'x' }])).toThrow(/needs agents/)
    expect(bad([{ event: 'PreCompact', command: 'x', agents: ['opencode'] }])).toThrow(/OpenCode only has Gloss’s events/)
    expect(bad([{ event: 'PostToolBatch', command: 'x', agents: ['codex'] }])).toThrow(/isn’t a codex event/)
    expect(bad([{ event: 'stop', matcher: 'shell', command: 'x' }])).toThrow(/only beforeTool and afterTool/)
    expect(bad([{ event: 'beforeTool', matcher: 'Bash', command: 'x' }])).toThrow(/own tool names need agents/)
    expect(bad([{ event: 'beforeTool', command: '' }])).toThrow(/command is required/)
    expect(bad([{ event: 'beforeTool', command: 'x', timeout: 0 }])).toThrow(/timeout/)
    expect(bad([{ event: 'beforeTool', command: 'x', agents: ['custom:local'] }])).toThrow(/agents lists/)
    expect(bad([{ event: 'beforeTool', command: 'x', type: 'command' }])).toThrow(/unsupported field type/)
  })
})

describe('planHook', () => {
  it('maps events and tool categories for each agent', () => {
    const [shell, read, mcp, any] = parseHooks(JSON.stringify({ hooks: [
      { event: 'beforeTool', matcher: 'shell', command: 'a' },
      { event: 'afterTool', matcher: 'read', command: 'b' },
      { event: 'beforeTool', matcher: 'mcp:My docs', command: 'c' },
      { event: 'beforeTool', matcher: 'any', command: 'd' }
    ] }))
    expect(planHook(shell, 'claude')).toEqual({ delivered: true, event: 'PreToolUse', matcher: 'Bash', command: 'a', timeout: 60 })
    expect(planHook(shell, 'opencode')).toEqual({ delivered: true, event: 'beforeTool', matcher: 'shell', command: 'a', timeout: 60 })
    expect(planHook(read, 'codex')).toEqual({ delivered: false, reason: 'codex has no read tool.' })
    expect(planHook(mcp, 'codex')).toMatchObject({ matcher: 'mcp__My_docs__.*' })
    expect(planHook(mcp, 'opencode')).toMatchObject({ matcher: 'My_docs_.*' })
    expect(planHook(any, 'claude')).not.toHaveProperty('matcher')
  })

  it('gives an agent-specific hook only to its agents, with its native event and matcher', () => {
    const [hook] = parseHooks(JSON.stringify({ hooks: [{ event: 'PreToolUse', matcher: 'Write', command: 'x', agents: ['claude'] }] }))
    expect(planHook(hook, 'claude')).toMatchObject({ delivered: true, event: 'PreToolUse', matcher: 'Write' })
    expect(planHook(hook, 'codex')).toEqual({ delivered: false, reason: 'Only for claude.' })
  })

  it('builds native and OpenCode configuration', () => {
    const list = parseHooks(JSON.stringify({ hooks: [
      { event: 'beforeTool', matcher: 'edit', command: 'a', timeout: 9 },
      { event: 'beforeTool', command: 'b' },
      { event: 'afterTool', matcher: 'read', command: 'c' },
      { event: 'PreCompact', command: 'd', agents: ['codex'] }
    ] }))
    expect(nativeHooks(list, 'codex')).toEqual({
      PreToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'a', timeout: 9 }] }, { hooks: [{ type: 'command', command: 'b', timeout: 60 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'd', timeout: 60 }] }]
    })
    expect(Object.keys(nativeHooks(list, 'claude'))).toEqual(['PreToolUse', 'PostToolUse'])
    expect(openCodeHooks(list)).toEqual([
      { event: 'beforeTool', matcher: '^(?:edit|write|patch)$', command: 'a', timeout: 9 },
      { event: 'beforeTool', command: 'b', timeout: 60 },
      { event: 'afterTool', matcher: '^(?:read)$', command: 'c', timeout: 60 }
    ])
  })
})

it('keeps Claude’s native events equal to the Agent SDK’s', async () => {
  const { HOOK_EVENTS } = await import('@anthropic-ai/claude-agent-sdk')
  expect(NATIVE_EVENTS.claude).toEqual([...HOOK_EVENTS])
})

describe('OpenCode hook plugin', () => {
  /** Loads the generated plugin with a fake OpenCode context and returns its registered hooks. */
  async function load(list: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-oc-plugin-'))
    writeFileSync(join(dir, 'index.mjs'), OPENCODE_HOOK_PLUGIN)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(list))
    const registered: Record<string, (e: unknown) => Promise<void>> = {}
    const plugin = (await import(pathToFileURL(join(dir, 'index.mjs')).href)).default
    await plugin.setup({
      location: { directory: dir },
      tool: { hook: async (name: string, fn: (e: unknown) => Promise<void>) => { registered[`tool.${name}`] = fn } },
      session: { hook: async (name: string, fn: (e: unknown) => Promise<void>) => { registered[`session.${name}`] = fn } },
      event: { subscribe: () => (async function* () {})() }
    })
    return { dir, registered }
  }
  const node = (script: string): string => `"${process.execPath}" -e "${script}"`

  it('blocks a matching tool on exit code 2, with stderr as the reason, and passes Claude-shaped input', async () => {
    const { dir, registered } = await load([{ event: 'beforeTool', matcher: '^(?:shell)$', command: node("let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const e=JSON.parse(s);if(e.hook_event_name==='PreToolUse'&&e.tool_input.command==='rm')process.stderr.write('no rm'),process.exit(2)})"), timeout: 10 }])
    await expect(registered['tool.execute.before']({ tool: 'shell', sessionID: 's', input: { command: 'rm' } })).rejects.toThrow('no rm')
    await expect(registered['tool.execute.before']({ tool: 'shell', sessionID: 's', input: { command: 'ls' } })).resolves.toBeUndefined()
    // Not a shell tool: the hook doesn't run.
    await expect(registered['tool.execute.before']({ tool: 'read', sessionID: 's', input: { command: 'rm' } })).resolves.toBeUndefined()
    expect(dir).toBeTruthy()
  })

  it('blocks a prompt on a JSON decision', async () => {
    const { registered } = await load([{ event: 'userPrompt', command: node("process.stdout.write(JSON.stringify({decision:'block',reason:'not now'}))"), timeout: 10 }])
    await expect(registered['session.prompt']({ sessionID: 's', prompt: { text: 'hi' } })).rejects.toThrow('not now')
  })

  it('carries on when a hook command fails or times out', async () => {
    const { registered } = await load([
      { event: 'beforeTool', command: node('process.exit(1)'), timeout: 10 },
      { event: 'beforeTool', command: node('setTimeout(()=>{},10000)'), timeout: 1 }
    ])
    await expect(registered['tool.execute.before']({ tool: 'shell', sessionID: 's', input: {} })).resolves.toBeUndefined()
  }, 10000)
})

