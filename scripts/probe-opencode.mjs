// ACP compatibility spike. No prompts, model calls, installs or project edits.
// Usage: node scripts/probe-opencode.mjs /absolute/path/to/opencode[.exe]
import { spawn } from 'node:child_process'
import console from 'node:console'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { clearTimeout, setTimeout } from 'node:timers'
import * as acp from '@agentclientprotocol/sdk'

const executable = process.argv[2] || 'opencode'
const root = mkdtempSync(join(tmpdir(), 'gloss-opencode-probe-'))
const cwd = join(root, 'project')
mkdirSync(cwd)

// Do not inherit provider credentials or the user's OpenCode configuration.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(key)
))
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  APPDATA: join(root, 'roaming'),
  LOCALAPPDATA: join(root, 'local'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    model: 'gloss-probe/probe',
    small_model: 'gloss-probe/probe',
    enabled_providers: ['gloss-probe'],
    provider: {
      'gloss-probe': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Gloss probe (no inference)',
        options: { baseURL: 'http://127.0.0.1:1/v1' },
        models: { probe: { name: 'Probe', limit: { context: 8192, output: 1024 } } }
      }
    }
  })
})

const child = spawn(executable, ['acp'], {
  cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
})
const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
// Drain stderr without printing possibly sensitive agent diagnostics.
child.stderr.resume()
let conn
let phase = 'launch'
let timer
try {
  await once(child, 'spawn')
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  conn = acp.client({ name: 'gloss' })
    .onNotification(acp.methods.client.session.update, () => {})
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
    .connect(stream)
  child.once('exit', () => conn.close(new Error('OpenCode exited during the probe')))
  const probe = async () => {
    phase = 'initialize'
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'gloss', title: 'Gloss compatibility probe', version: '0.1.0' },
      clientCapabilities: { auth: { terminal: true } }
    })
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error('Incompatible ACP version')
    const capabilities = init.agentCapabilities ?? {}
    phase = 'session/new'
    const created = await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const results = { newSession: true, listSessions: null, loadSession: null, closeSession: null }
    if (capabilities.sessionCapabilities?.list) {
      phase = 'session/list'
      const listed = await conn.agent.request(acp.methods.agent.session.list, { cwd })
      results.listSessions = listed.sessions.some((session) => session.sessionId === created.sessionId)
      if (!results.listSessions) throw new Error('Created session is missing from session/list')
    }
    if (capabilities.sessionCapabilities?.close) {
      phase = 'session/close'
      await conn.agent.request(acp.methods.agent.session.close, { sessionId: created.sessionId })
      results.closeSession = true
    }
    if (capabilities.loadSession) {
      phase = 'session/load'
      await conn.agent.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId, cwd, mcpServers: []
      })
      results.loadSession = true
    }
    return {
      agent: init.agentInfo,
      protocolVersion: init.protocolVersion,
      capabilities,
      authMethods: (init.authMethods ?? []).map(({ id, type, _meta }) => ({
        id, type, legacyTerminalAuth: Boolean(_meta?.['terminal-auth'])
      })),
      configOptions: (created.configOptions ?? []).map(({ id, category }) => ({ id, category })),
      results,
      inferenceTested: false
    }
  }
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Probe timed out')), 30_000)
  })
  console.log(JSON.stringify(await Promise.race([probe(), timeout]), null, 2))
} catch {
  console.error(`OpenCode compatibility probe failed during ${phase}. Check the executable and run opencode acp directly for diagnostics.`)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  conn?.close()
  if (child.exitCode === null && child.pid) {
    child.kill()
    await exited
  }
  // Only remove the temporary directory this script created.
  const tempRoot = resolve(tmpdir()) + sep
  const cleanupPath = resolve(root)
  if (cleanupPath.startsWith(tempRoot) && cleanupPath.slice(tempRoot.length).startsWith('gloss-opencode-probe-')) {
    try {
      rmSync(cleanupPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      console.error('Temporary probe files could not be removed because they are still in use.')
      process.exitCode = 1
    }
  }
}
