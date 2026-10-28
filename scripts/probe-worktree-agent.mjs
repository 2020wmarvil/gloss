// Worktree spike, agent side: an adapter with a worktree as its cwd. Sends one short prompt
// (Haiku for Claude, the smallest listed model for Codex) and deletes the session afterwards.
// Usage: node scripts/probe-worktree-agent.mjs claude|codex
// Run from a shell without CLAUDE*/ANTHROPIC* variables from a host session.
import { execFileSync, spawn } from 'node:child_process'
import console from 'node:console'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { setTimeout } from 'node:timers'
import * as acp from '@agentclientprotocol/sdk'

const which = process.argv[2] === 'codex' ? 'codex' : 'claude'
// With a mode id, the probe stays in that mode and asks for a commit instead.
const modeArg = process.argv[3]
// 'project' runs the session in the project folder instead, to compare.
const inProject = process.argv[4] === 'project'
const require = createRequire(import.meta.url)
const entry = require.resolve(which === 'codex' ? '@agentclientprotocol/codex-acp/dist/index.js' : '@agentclientprotocol/claude-agent-acp/dist/index.js')

const root = mkdtempSync(join(tmpdir(), 'gloss-worktree-agent-'))
const repo = join(root, 'project')
const wt = join(root, 'worktrees', 'project', 'k3f9')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
mkdirSync(repo)
git(repo, 'init', '-q', '-b', 'dev')
git(repo, 'config', 'user.email', 'probe@example.com')
git(repo, 'config', 'user.name', 'Probe')
writeFileSync(join(repo, 'README.md'), '# probe\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
git(repo, 'worktree', 'add', '-q', '-b', 'gloss/k3f9', wt, 'dev')

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)))
env.ELECTRON_RUN_AS_NODE = '1'
if (which === 'claude') env.ANTHROPIC_MODEL = 'haiku'

const child = spawn(process.execPath, [entry], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
child.stderr.resume()
let text = ''
const conn = acp.client({ name: 'gloss' })
  .onNotification(acp.methods.client.session.update, ({ params: { update } }) => {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') text += update.content.text
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params: { options } }) => {
    const allow = options.find((o) => o.kind === 'allow_once') ?? options[0]
    return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
const req = (m, p) => conn.agent.request(m, p)
const results = { agent: which }
let sessionId
try {
  const init = await req(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
  results.agentInfo = init.agentInfo
  const created = await req(acp.methods.agent.session.new, { cwd: inProject ? repo : wt, mcpServers: [] })
  sessionId = created.sessionId
  const bypass = which === 'codex' ? 'agent-full-access' : 'bypassPermissions'
  results.modes = created.modes?.availableModes?.map((m) => m.id)
  if (modeArg) results.mode = modeArg
  if (modeArg && modeArg !== created.modes?.currentModeId) await req(acp.methods.agent.session.setMode, { sessionId, modeId: modeArg })
  else if (!modeArg && created.modes?.availableModes?.some((m) => m.id === bypass)) await req(acp.methods.agent.session.setMode, { sessionId, modeId: bypass })
  if (which === 'codex') {
    const model = created.configOptions?.find((o) => o.category === 'model')
    const values = (model?.options ?? []).flatMap((o) => ('options' in o ? o.options : [o]))
    const small = values.find((v) => /mini|nano/i.test(v.value ?? v.name))
    if (model && small) {
      await req(acp.methods.agent.session.setConfigOption, { sessionId, configId: model.id, value: small.value })
      results.model = small.value
    }
  }
  // The note Gloss would put first in the session's first message, as reviews do with their range.
  const note = inProject ? '' : `[You are working in a git worktree at ${wt}, on branch gloss/k3f9. The project folder is ${repo}.]`
  const prompt = modeArg
    ? `${note}\nCreate a file named probe.txt containing the word hi, then run git add probe.txt and git commit -m probe. Reply with one line: the commit hash, or the exact error.`
    : `${note}\nCreate a file named probe.txt containing the word hi in your working directory. Then reply with one line: the absolute path of your working directory and the current git branch.`
  const res = await req(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] })
  results.stopReason = res.stopReason
  results.answer = text.trim()
  results.fileInWorktree = existsSync(join(wt, 'probe.txt'))
  results.fileInProjectFolder = existsSync(join(repo, 'probe.txt'))
  results.worktreeLog = git(wt, 'log', '--oneline', '-3')
  results.projectLog = git(repo, 'log', '--oneline', '-3')
  results.fileInProjectFolder = existsSync(join(repo, 'probe.txt'))
  const pick = (l) => l.sessions.filter((s) => s.sessionId === sessionId).map(({ sessionId: _, ...rest }) => rest)
  results.listedForWorktree = pick(await req(acp.methods.agent.session.list, { cwd: wt }))
  results.listedForProjectFolder = pick(await req(acp.methods.agent.session.list, { cwd: repo }))
  if (which === 'claude') {
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
    results.transcriptFolders = readdirSync(projects).filter((d) => d.includes('k3f9') || d.includes(root.split(/[\\/]/).pop()))
  }
  await req(acp.methods.agent.session.close, { sessionId })
  await req(acp.methods.agent.session.load, { sessionId, cwd: wt, mcpServers: [] })
  results.loadedInWorktree = true
} catch (e) {
  results.error = String(e?.message ?? e)
} finally {
  if (sessionId) {
    try { await req(acp.methods.agent.session.delete, { sessionId }); results.deleted = true } catch (e) { results.deleted = String(e?.message ?? e) }
  }
  console.log(JSON.stringify(results, null, 2))
  conn.close()
  child.kill()
  await new Promise((r) => setTimeout(r, 500))
  if (which === 'claude') for (const d of results.transcriptFolders ?? []) rmSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', d), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
