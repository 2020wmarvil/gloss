// Opt in with GLOSS_PLUGIN_NATIVE=1. Real adapters, local mock inference and a local MCP server.
// OpenCode checks additionally need GLOSS_OPENCODE_EXECUTABLE. No hosted credentials are inherited.
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { PluginLibrary } from './plugins'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, type AgentConfig } from './agents'
import type { McpServer } from '../shared/mcp'

const mcpScript = String.raw`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{try{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'plugin-probe',version:'1'}}:q.method==='tools/list'?{tools:[{name:'plugin_probe',description:'GLOSS_PLUGIN_MCP_MARKER',inputSchema:{type:'object',properties:{}}}]}:q.method==='tools/call'?{content:[{type:'text',text:'Plugin MCP works'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n')}catch{}});`

it.skipIf(!process.env.GLOSS_PLUGIN_NATIVE).for(['claude', 'codex', 'opencode', 'custom:probe'])('loads a complete authored package through %s and removes only its deployment', { timeout: 120000 }, async (agentId, context) => {
  if (['opencode', 'custom:probe'].includes(agentId) && !process.env.GLOSS_OPENCODE_EXECUTABLE) { context.skip(); return }
  const root = mkdtempSync(join(tmpdir(), 'gloss-plugin-native-'))
  // Checked before the test runs, so the cleanup below can't hide a failure by throwing.
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid test cleanup path.')
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const marker = `GLOSS_PLUGIN_BODY_${randomUUID()}`
  const resource = `GLOSS_PLUGIN_RESOURCE_${randomUUID()}`
  const payloads: { url: string; body: Record<string, unknown> }[] = []
  let calls: { name: string; args: object }[] = []
  let serial = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw || '{}'); payloads.push({ url: req.url ?? '', body })
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":100}'); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (req.url?.includes('/messages')) {
      const next = calls.shift()
      const block = next ? { type: 'tool_use', id: `tool_${++serial}`, name: next.name, input: next.args } : { type: 'text', text: 'ACK' }
      const event = (type: string, data: object): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`) }
      event('message_start', { message: { id: `msg_${++serial}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: next ? { ...block, input: {} } : { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: next ? { type: 'input_json_delta', partial_json: JSON.stringify(next.args) } : { type: 'text_delta', text: 'ACK' } })
      event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: next ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }); event('message_stop', {}); res.end(); return
    }
    if (req.url?.includes('/responses')) {
      const text = body.text?.format?.schema?.properties?.title ? '{"title":"Plugin probe"}' : 'ACK'
      const item = { id: `msg_${++serial}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      const response = { id: `resp_${++serial}`, object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 0 } } }
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end(); return
    }
    const next = calls.shift()
    const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ id: `chat_${serial}`, object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.end(next ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${++serial}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n' : chunk({ role: 'assistant', content: 'ACK' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(key))),
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), CODEX_HOME: join(root, '.codex'), CLAUDE_CONFIG_DIR: join(root, '.claude'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    ANTHROPIC_API_KEY: 'local-test', ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', OPENCODE_DISABLE_MODELS_FETCH: 'true'
  }
  mkdirSync(env.CODEX_HOME)
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local probe"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const connections: McpServer[] = [{ name: 'plugin-docs', command: process.execPath, args: ['-e', mcpScript], env: [] }]
  const library = new PluginLibrary({ directory: join(root, 'plugins'), agents: () => [{ id: agentId, name: agentId }], connections: () => connections })
  const id = library.create('Native probe', 'Only for plugin integration testing')
  const skill = library.list().plugins[0].skills[0]
  const file = library.readFile(id, skill.path)
  library.writeFile(id, { ...file, content: file.content + `\n${marker}\nRead references/value.txt.\n` })
  library.createFile(id, skill.id, 'references/value.txt', resource)
  library.update(id, { connections: ['plugin-docs'] })
  const customRoot = join(root, 'custom-skills')
  if (agentId.startsWith('custom:')) library.setSkillDirectory(agentId, customRoot)
  library.enable(id, agentId, true)
  let connection: AgentConnection | undefined
  const updates: SessionNotification[] = []
  function config(): AgentConfig {
    const native = agentId === 'claude' || agentId === 'codex' ? getAgentConfig(agentId) : {
      id: agentId, name: agentId, command: process.env.GLOSS_OPENCODE_EXECUTABLE!, args: ['acp'],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'probe/probe', update: 'disable', snapshots: false, agents: { title: { disabled: true } },
        ...(agentId.startsWith('custom:') ? { skills: [customRoot] } : {}),
        policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'probe', effect: 'allow' }],
        providers: { probe: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${base}/v1`, apiKey: 'local-test' }, models: { probe: { name: 'Probe', limit: { context: 65536, output: 1024 } } } } }
      }) }
    }
    return library.configureAgent(native)
  }
  async function connect(): Promise<AgentConfig> {
    const c = config(); connection = await AgentConnection.start(c, agentEnv(c, env), {
      onUpdate: n => updates.push(n), onStderr() {}, onClosed() {},
      onPermission: async req => { const allow = req.options.find(o => o.kind === 'allow_once'); return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } }
    })
    return c
  }
  async function start(): Promise<string> {
    const c = await connect()
    const session = await connection!.newSession(cwd, c.sessionMeta?.('Plugin test instructions').new, connections)
    return session.sessionId
  }
  /** A new connection resuming the session, as Gloss does after a plugin refresh. */
  async function resume(session: string): Promise<void> {
    const c = await connect()
    await connection!.loadSession(session, cwd, c.sessionMeta?.('Plugin test instructions').load, connections)
  }
  async function useSkill(session: string): Promise<void> {
    if (agentId === 'claude' || agentId === 'codex') {
      await viWait(() => updates.some(n => n.sessionId === session && n.update.sessionUpdate === 'available_commands_update' && n.update.availableCommands.some(c => c.name.includes(skill.id))))
      const command = updates.flatMap(n => n.update.sessionUpdate === 'available_commands_update' ? n.update.availableCommands : []).find(c => c.name.includes(skill.id))!
      if (agentId === 'claude') calls = [{ name: 'Read', args: { file_path: join(library.folder(id), 'skills', skill.id, 'references/value.txt') } }]
      await connection!.prompt(session, [{ type: 'text', text: agentId === 'claude' ? `/${command.name}` : command.name }])
    } else {
      calls = [{ name: 'skill', args: { id: agentId.startsWith('custom:') ? `gloss-${skill.id}` : skill.id } }, { name: 'read', args: { path: join(library.folder(id), 'skills', skill.id, 'references/value.txt') } }]
      await connection!.prompt(session, [{ type: 'text', text: 'Use the native-probe skill and its supporting file.' }])
    }
  }
  try {
    const session = await start()
    await useSkill(session)
    expect(JSON.stringify(payloads).includes(marker), 'Native skill instructions reached the provider').toBe(true)
    expect(JSON.stringify(payloads).includes('plugin_probe'), 'Local MCP tool was advertised').toBe(true)
    if (agentId !== 'codex') expect(JSON.stringify(payloads).includes(resource), 'Native supporting-file read reached the provider').toBe(true)
    // Edit the skill it just used, restart and resume the same session: the revised text reaches the provider.
    const revised = `GLOSS_PLUGIN_REVISED_${randomUUID()}`
    const current = library.readFile(id, skill.path)
    library.writeFile(id, { ...current, content: current.content.replace(marker, revised) })
    connection!.dispose(); connection = undefined
    payloads.length = 0; updates.length = 0
    await resume(session)
    await useSkill(session)
    expect(JSON.stringify(payloads).includes(revised), 'Revised skill instructions reached the provider after a resume').toBe(true)
    connection!.dispose(); connection = undefined
    // Direct-only removes discovery while preserving native explicit loading.
    const policy = library.list().plugins[0].skills[0]
    library.setSkillInvocation(id, skill.id, 'direct', policy.invocationRevision)
    payloads.length = 0; updates.length = 0
    const direct = await start()
    await connection!.prompt(direct, [{ type: 'text', text: 'Reply with ACK.' }])
    expect(JSON.stringify(payloads).includes('Only for plugin integration testing'), 'Direct-only skill is absent from automatic discovery').toBe(false)
    await useSkill(direct)
    expect(JSON.stringify(payloads).includes(revised), 'Direct-only skill can still be explicitly loaded').toBe(true)
    connection!.dispose(); connection = undefined
    const directPolicy = library.list().plugins[0].skills[0]
    library.setSkillInvocation(id, skill.id, 'automatic', directPolicy.invocationRevision)
    payloads.length = 0; updates.length = 0
    const automatic = await start()
    await connection!.prompt(automatic, [{ type: 'text', text: 'Reply with ACK.' }])
    expect(JSON.stringify(payloads).includes('Only for plugin integration testing'), 'Automatic skill is advertised again').toBe(true)
    connection!.dispose(); connection = undefined
    library.enable(id, agentId, false)
    payloads.length = 0; updates.length = 0
    const fresh = await start()
    await connection!.prompt(fresh, [{ type: 'text', text: 'Reply with ACK.' }])
    for (let i = 0; i < 10 && !JSON.stringify(payloads).includes('plugin_probe'); i++) {
      await new Promise(r => setTimeout(r, 100))
      await connection!.prompt(fresh, [{ type: 'text', text: 'Check the available tools and reply ACK.' }])
    }
    expect(JSON.stringify(payloads).includes(marker), 'Disabled plugin body is absent').toBe(false)
    expect(JSON.stringify(payloads).includes('Only for plugin integration testing'), 'Disabled plugin catalog entry is absent').toBe(false)
    expect(JSON.stringify(payloads).includes('plugin_probe'), 'Local MCP tool was advertised').toBe(true) // Global connection survives disabling this plugin.
  } finally {
    connection?.dispose(); library.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function viWait(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 100)) }
  throw new Error('The native agent did not advertise the plugin skill.')
}
