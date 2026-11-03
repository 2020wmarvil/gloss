// The performance benchmark (M25, docs/performance/README.md). Seeds a scratch user data
// folder with large sessions, launches the built app with a fake streaming agent, drives it
// over CDP and writes the measurements to JSON, then compares them with this machine's baseline.
//
//   npm run bench                     build, seed, measure, compare
//   npm run bench -- --update-baseline  record this run as the machine's baseline
//   options: --skip-build --rounds=<startup launches> --soak-minutes=<n> --profile --output=<file>
/* global fetch */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { compare, machineId } from './compare.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..')
const { values } = parseArgs({ options: {
  'skip-build': { type: 'boolean', default: false },
  rounds: { type: 'string', default: '3' },
  'soak-minutes': { type: 'string', default: '4' },
  profile: { type: 'boolean', default: false },
  output: { type: 'string', default: join(root, 'out/bench/results.json') },
  'update-baseline': { type: 'boolean', default: false },
  'no-compare': { type: 'boolean', default: false },
  'keep-data': { type: 'boolean', default: false },
  only: { type: 'string' },
  // Another checkout of Gloss to measure (built there), e.g. a worktree of the commit before a change.
  app: { type: 'string' }
} })
const appDir = values.app ? resolve(values.app) : root
const rounds = Number(values.rounds)
const soakMinutes = Number(values['soak-minutes'])
const only = values.only ? new Set(values.only.split(',')) : null
const wanted = (name) => !only || only.has(name)
const electron = require('electron')
const outDir = join(root, 'out/bench')
mkdirSync(outDir, { recursive: true })

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], ...options })
    let stdout = ''
    child.stdout?.on('data', (b) => { stdout += b })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))))
  })
}

/** The environment Gloss runs in: no inherited agent sessions or credentials, scratch agent homes. */
function cleanEnv(scratch) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(CLAUDE|ANTHROPIC)/i.test(k) && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(k.toUpperCase())))
  env.CLAUDE_CONFIG_DIR = join(scratch, 'claude-home')
  env.CODEX_HOME = join(scratch, 'codex-home')
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  mkdirSync(env.CODEX_HOME, { recursive: true })
  // A placeholder key, so listing Codex sessions (local files) doesn't ask to sign in. No prompt is ever sent to Codex.
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-gloss-bench-placeholder' }))
  return env
}

// --- Build and seed ---------------------------------------------------------------

if (!values['skip-build']) {
  console.log('Building…')
  await run(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: appDir, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** The seeded data, kept between runs while the seed code is unchanged. */
async function template() {
  // The app's own Store seeds it: its schema, as that version of Gloss would have written it.
  if (appDir !== root) {
    mkdirSync(join(appDir, 'scripts/bench'), { recursive: true })
    for (const f of ['seed.ts', 'content.mjs']) cpSync(join(root, 'scripts/bench', f), join(appDir, 'scripts/bench', f))
  }
  const sources = ['scripts/bench/seed.ts', 'scripts/bench/content.mjs', 'src/main/db.ts', 'src/shared/wire.ts']
  const hash = createHash('sha256').update(appDir + sources.map((f) => readFileSync(join(appDir, f))).join('\0')).digest('hex').slice(0, 12)
  const dir = join(outDir, `seed-${hash}`)
  if (existsSync(join(dir, 'summary.json'))) return { dir, summary: JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) }
  // Older seeds of this checkout; another checkout's (--app) stay.
  for (const old of readdirSync(outDir).filter((f) => f.startsWith('seed-') && f !== 'seed-build')) {
    const summary = join(outDir, old, 'summary.json')
    if (!existsSync(summary) || JSON.parse(readFileSync(summary, 'utf8')).app === appDir) rmSync(join(outDir, old), { recursive: true, force: true })
  }
  console.log('Seeding…')
  const { build } = await import('vite')
  await build({
    configFile: false, logLevel: 'error', root,
    build: { target: 'node24', outDir: join(outDir, 'seed-build'), emptyOutDir: true, minify: false,
      lib: { entry: join(appDir, 'scripts/bench/seed.ts'), formats: ['cjs'], fileName: () => 'seed.cjs' },
      rollupOptions: { external: (id) => id.startsWith('node:') } }
  })
  const data = join(dir, 'data')
  const project = join(dir, 'project')
  mkdirSync(data, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Benchmark project\n')
  const started = Date.now()
  const out = await run(electron, [join(outDir, 'seed-build/seed.cjs'), data, project, 'custom:bench'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const summary = { ...JSON.parse(out.trim().split('\n').at(-1)), seedMs: Date.now() - started, app: appDir }
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  return { dir, summary }
}

const seeded = await template()
const db = new DatabaseSync(join(seeded.dir, 'data/gloss.db'), { readOnly: true })
const firstThread = (sessionId) => db.prepare(`SELECT t.id, (SELECT m.id FROM messages m WHERE m.thread_id = t.id ORDER BY m.seq LIMIT 1) AS first
  FROM threads t WHERE t.session_id = ? ORDER BY t.created_at DESC LIMIT 1`).get(sessionId)
const dbBytes = readFileSync(join(seeded.dir, 'data/gloss.db')).length


// --- One app launch ---------------------------------------------------------------

function freePort() {
  return new Promise((resolvePromise) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

async function json(url, tries = 400) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch { /* not listening yet */ }
    await delay(25)
  }
  throw new Error(`No answer from ${url}`)
}

/** A CDP session over a WebSocket. */
async function cdp(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 1 << 30 })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  let next = 1
  const pending = new Map()
  const listeners = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
      else ok(msg.result)
    } else if (msg.method) for (const f of listeners.get(msg.method) ?? []) f(msg.params)
  })
  const send = (method, params = {}) => new Promise((ok, reject) => {
    const id = next++
    pending.set(id, { resolve: ok, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const on = (method, f) => listeners.set(method, [...(listeners.get(method) ?? []), f])
  const once = (method) => new Promise((ok) => on(method, ok))
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`)
    return r.result.value
  }
  return { send, on, once, evaluate, close: () => ws.close() }
}

// Injected into every page before its scripts: long tasks, frames, input event timing, and
// when the sidebar and a session's log first show.
const INSTRUMENT = `(() => {
  if (window.__bench) return
  const b = window.__bench = { phase: 'startup', tasks: [], frames: [], events: [], marks: {}, layoutShifts: 0 }
  new PerformanceObserver((l) => { for (const e of l.getEntries()) b.tasks.push({ start: e.startTime, ms: e.duration, phase: b.phase }) }).observe({ type: 'longtask', buffered: true })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) b.events.push({ name: e.name, start: e.startTime, ms: e.duration, delay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart, phase: b.phase }) }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  let last = performance.now()
  const frame = (now) => { b.frames.push({ ms: now - last, phase: b.phase }); last = now; requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  const seen = () => {
    if (b.marks.sidebar === undefined && document.querySelector('.session-row')) b.marks.sidebar = performance.now()
    if (b.marks.log === undefined && document.querySelector('.log [data-message-id]')) b.marks.log = performance.now()
    if (b.marks.composer === undefined && document.querySelector('.composer .cm-content')) b.marks.composer = performance.now()
    for (const [name, sel] of Object.entries(b.waitFor ?? {})) if (b.marks[name] === undefined && document.querySelector(sel)) b.marks[name] = performance.now()
  }
  new MutationObserver(seen).observe(document, { childList: true, subtree: true, characterData: true })
})()`

/** Runs the hooks the benchmark needs in the paused main process, then lets it start. */
async function launch(label) {
  const scratch = mkdtempSync(join(tmpdir(), 'gloss-bench-'))
  const data = join(scratch, 'data')
  cpSync(join(seeded.dir, 'data'), data, { recursive: true })
  const agentDir = join(data, 'bench-agent')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({
    defaultAgent: 'custom:bench',
    permissionMode: 'bypass',
    agentProfiles: [{ id: 'custom:bench', name: 'Bench agent', command: process.execPath, args: [join(root, 'scripts/bench/fake-agent.mjs'), agentDir, '{instructions}'], env: {} }]
  }, null, 2))
  const [debugPort, inspectPort] = [await freePort(), await freePort()]
  const env = cleanEnv(scratch)
  const child = spawn(electron, [appDir, `--user-data-dir=${data}`, `--remote-debugging-port=${debugPort}`, `--inspect-brk=${inspectPort}`], {
    cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (b) => { log += b })
  child.stderr.on('data', (b) => { log += b })
  const exited = new Promise((r) => child.on('exit', r))
  const [target] = await json(`http://127.0.0.1:${inspectPort}/json/list`)
  const main = await cdp(target.webSocketDebuggerUrl)
  const paused = main.once('Debugger.paused')
  await main.send('Runtime.enable')
  await main.send('Debugger.enable')
  await main.send('Runtime.runIfWaitingForDebugger')
  const { callFrames } = await paused
  // Paused in Electron's default app, before it loads Gloss.
  const hook = await main.send('Debugger.evaluateOnCallFrame', { callFrameId: callFrames[0].callFrameId, returnByValue: true, expression: `(() => {
    const electron = process.getBuiltinModule('node:module').createRequire(process.cwd() + '/')('electron')
    const { app } = electron
    const b = globalThis.__bench = { electron, processStart: Date.now() - process.uptime() * 1000, pausedAt: Date.now(), ipc: { count: 0, bytes: 0, byType: {} } }
    app.on('browser-window-created', (_e, win) => win.once('show', () => { b.shownAt ??= Date.now() }))
    app.on('web-contents-created', (_e, wc) => {
      try {
        wc.debugger.attach('1.3')
        void wc.debugger.sendCommand('Page.enable')
        void wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: ${JSON.stringify(INSTRUMENT)}, runImmediately: true })
        if (${values.profile ? 'true' : 'false'} && !b.profiling) {
          // --profile: the renderer's startup, from before its first script.
          b.profiling = wc
          void wc.debugger.sendCommand('Profiler.enable').then(() => wc.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 200 })).then(() => wc.debugger.sendCommand('Profiler.start'))
        }
      } catch {}
      // Counts the events sent to windows: messages, and bytes as JSON.
      const send = wc.send.bind(wc)
      wc.send = (channel, ...args) => {
        if (channel === 'gloss:event') {
          const size = JSON.stringify(args[0] ?? null).length
          const type = args[0]?.type ?? '?'
          b.ipc.count++
          b.ipc.bytes += size
          const t = b.ipc.byType[type] ??= { count: 0, bytes: 0 }
          t.count++
          t.bytes += size
        }
        return send(channel, ...args)
      }
    })
    return { processStart: b.processStart, pausedAt: b.pausedAt }
  })()` })
  if (hook.exceptionDetails) throw new Error(JSON.stringify(hook.exceptionDetails))
  const { processStart, pausedAt } = hook.result.value
  if (values.profile && label === 'startup-0') {
    await main.send('Profiler.enable')
    await main.send('Profiler.setSamplingInterval', { interval: 200 })
    await main.send('Profiler.start')
  }
  const resumedAt = Date.now()
  await main.send('Debugger.disable')
  await main.send('Runtime.evaluate', { expression: 'globalThis.__bench.resumedAt = Date.now()' })
  await main.send('Debugger.resume').catch(() => {})
  const offset = resumedAt - pausedAt
  // The main window: its URL ends in /index.html (session windows carry ?session=).
  let page
  for (let i = 0; i < 400 && !page; i++) {
    const list = await json(`http://127.0.0.1:${debugPort}/json/list`)
    page = list.find((t) => t.type === 'page' && /\/index\.html$/.test(t.url))
    if (!page) await delay(25)
  }
  if (!page) throw new Error('No main window')
  const renderer = await cdp(page.webSocketDebuggerUrl)
  await renderer.send('Runtime.enable')
  await renderer.send('Performance.enable')
  const app = {
    label, scratch, data, agentDir, child, main, renderer, exited,
    /** Epoch ms → ms after launch, excluding the pause to attach the debugger. */
    sinceLaunch: (epoch) => epoch - processStart - offset,
    log: () => log
  }
  await waitFor(app, 'document.readyState === "complete" && !!window.__bench', 20000)
  return app
}

async function quit(app) {
  await app.main.evaluate("globalThis.__bench.electron.app.quit()").catch(() => {})
  await Promise.race([app.exited, delay(15000)])
  if (app.child.exitCode === null) app.child.kill()
  app.main.close()
  app.renderer.close()
  if (values['keep-data']) return
  try {
    rmSync(app.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (err) {
    console.warn(`Couldn't remove ${app.scratch}: ${err.message}`)
  }
}

async function waitFor(app, expression, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await app.renderer.evaluate(`!!(${expression})`).catch(() => false)) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

/** Waits until the renderer has had no long task for `quietMs`. */
async function settle(app, quietMs = 1000, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const idle = await app.renderer.evaluate(`(() => { const t = window.__bench.tasks.at(-1); return t ? performance.now() - (t.start + t.ms) : performance.now() })()`)
    if (idle >= quietMs) return
    await delay(100)
  }
}

const phase = (app, name) => app.renderer.evaluate(`window.__bench.phase = ${JSON.stringify(name)}`)

async function center(app, selector) {
  const rect = await app.renderer.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 12) } })()`)
  if (!rect) throw new Error(`No element ${selector}: ${JSON.stringify(await app.renderer.evaluate(`({ threads: [...document.querySelectorAll('[data-thread]')].slice(0, 5).map((e) => e.outerHTML.slice(0, 160)), messages: document.querySelectorAll('.log [data-message-id]').length })`))}`)
  return rect
}

async function click(app, selector) {
  const { x, y } = await center(app, selector)
  const hit = await app.renderer.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); const want = document.querySelector(${JSON.stringify(selector)}); return !el ? 'nothing' : want.contains(el) ? null : el.outerHTML.slice(0, 200) })()`)
  if (hit) throw new Error(`Clicking ${selector} at ${Math.round(x)},${Math.round(y)} would hit ${hit}`)
  await app.renderer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await app.renderer.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await app.renderer.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function key(app, k, modifiers = 0, text) {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Backspace: 8, Delete: 46 }[k]
  await app.renderer.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) })
  await app.renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}

/** Clicks, then measures until `selector` shows: the time, and the long tasks meanwhile. */
async function timedClick(app, name, clickSelector, doneSelector) {
  await app.renderer.evaluate(`(() => { const b = window.__bench; delete b.marks[${JSON.stringify(name)}]; b.waitFor = { ${JSON.stringify(name)}: ${JSON.stringify(doneSelector)} }; b.marks[${JSON.stringify(name + 'Start')}] = performance.now() })()`)
  await phase(app, name)
  await click(app, clickSelector)
  await waitFor(app, `window.__bench.marks[${JSON.stringify(name)}] !== undefined`).catch(async (err) => {
    const state = await app.renderer.evaluate(`({ on: document.querySelector('.session-row.on')?.title, notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText), ids: [...document.querySelectorAll('.log [data-message-id]')].slice(-3).map((e) => e.dataset.messageId), done: ${JSON.stringify(doneSelector)} })`)
    throw new Error(`${err.message}
${JSON.stringify(state)}`)
  })
  await settle(app, 500)
  const r = await app.renderer.evaluate(`(() => { const b = window.__bench; const start = b.marks[${JSON.stringify(name + 'Start')}]; const tasks = b.tasks.filter((t) => t.phase === ${JSON.stringify(name)}); b.phase = 'idle'; return { ms: b.marks[${JSON.stringify(name)}] - start, busyUntilMs: Math.max(0, ...tasks.map((t) => t.start + t.ms - start)), longTasks: tasks.length, maxLongTaskMs: Math.max(0, ...tasks.map((t) => t.ms)) } })()`)
  return r
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null }
}

async function phaseSummary(app, name) {
  return app.renderer.evaluate(`(() => {
    const b = window.__bench
    const tasks = b.tasks.filter((t) => t.phase === ${JSON.stringify(name)})
    const frames = b.frames.filter((f) => f.phase === ${JSON.stringify(name)}).map((f) => f.ms).sort((a, c) => a - c)
    const events = b.events.filter((e) => e.phase === ${JSON.stringify(name)})
    const q = (list, p) => list.length ? list[Math.min(list.length - 1, Math.ceil(p * list.length) - 1)] : 0
    return { longTasks: tasks.length, longTaskMs: tasks.reduce((n, t) => n + t.ms, 0), maxLongTaskMs: Math.max(0, ...tasks.map((t) => t.ms)),
      frames: frames.length, frameP50Ms: q(frames, 0.5), frameP95Ms: q(frames, 0.95), frameMaxMs: frames.at(-1) ?? 0, framesOver50Ms: frames.filter((ms) => ms > 50).length,
      slowEvents: events.length, eventMaxMs: Math.max(0, ...events.map((e) => e.ms)) }
  })()`)
}

async function metrics(app) {
  const m = Object.fromEntries((await app.renderer.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
  return m
}

/** Memory of each Gloss process, from Electron, after a garbage collection in both JS heaps. */
async function memory(app) {
  await app.renderer.send('HeapProfiler.collectGarbage').catch(() => {})
  await app.main.send('HeapProfiler.collectGarbage').catch(() => {})
  await delay(300)
  const procs = await app.main.evaluate(`globalThis.__bench.electron.app.getAppMetrics().map((p) => ({ type: p.type, name: p.name ?? null, workingSetKB: p.memory.workingSetSize, privateKB: p.memory.privateBytes ?? null }))`)
  const heap = await app.renderer.send('Runtime.getHeapUsage')
  const mainHeap = await app.main.send('Runtime.getHeapUsage')
  const dom = await app.renderer.evaluate(`({ nodes: document.getElementsByTagName('*').length, images: document.images.length, decodedImages: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length, imageBytesInDom: [...document.images].reduce((n, i) => n + (i.src.startsWith('data:') ? i.src.length : 0), 0) })`)
  const sum = (type) => procs.filter((p) => p.type === type).reduce((n, p) => n + p.workingSetKB, 0)
  return { rendererHeapMB: heap.usedSize / 1048576, mainHeapMB: mainHeap.usedSize / 1048576, rendererWorkingSetMB: sum('Tab') / 1024, mainWorkingSetMB: sum('Browser') / 1024, gpuWorkingSetMB: sum('GPU') / 1024, totalWorkingSetMB: procs.reduce((n, p) => n + p.workingSetKB, 0) / 1024, dom }
}

async function mainCpu(app) {
  return app.main.evaluate('(() => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 })()')
}

const ipc = (app) => app.main.evaluate('({ ...globalThis.__bench.ipc, byType: JSON.parse(JSON.stringify(globalThis.__bench.ipc.byType)) })')

async function setAgent(app, config) {
  writeFileSync(join(app.agentDir, 'config.json'), JSON.stringify(config))
}

/** Profiles the renderer and main process around `fn` when --profile is on, saving .cpuprofile files. */
async function profiled(app, name, fn) {
  if (!values.profile) return fn()
  await app.renderer.send('Profiler.enable')
  await app.main.send('Profiler.enable')
  await app.renderer.send('Profiler.setSamplingInterval', { interval: 200 })
  await app.renderer.send('Profiler.start')
  await app.main.send('Profiler.start')
  try {
    return await fn()
  } finally {
    const r = await app.renderer.send('Profiler.stop')
    const m = await app.main.send('Profiler.stop')
    mkdirSync(join(outDir, 'profiles'), { recursive: true })
    writeFileSync(join(outDir, 'profiles', `${name}.renderer.cpuprofile`), JSON.stringify(r.profile))
    writeFileSync(join(outDir, 'profiles', `${name}.main.cpuprofile`), JSON.stringify(m.profile))
  }
}

// --- Scenarios --------------------------------------------------------------------

const S = seeded.summary.sessions
const imageSession = S[0]
const codeSession = S[1]
const mediums = S.slice(2, 5)
const row = (s) => `.session-row[title=${JSON.stringify(s.title)}]`
// The session's header with log entries under it (its newest entries mount first).
const shown = (s) => `.conversation:has(h1[title=${JSON.stringify(s.title)}]) .log [data-message-id]`

async function startup(app) {
  await waitFor(app, `document.querySelector(${JSON.stringify(shown(imageSession))})`, 60000)
  await settle(app, 2000, 60000)
  const r = await app.renderer.evaluate(`(() => { const b = window.__bench; return { origin: performance.timeOrigin, paint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? performance.getEntriesByType('paint')[0]?.startTime, marks: b.marks, tasks: b.tasks.filter((t) => t.phase === 'startup') } })()`)
  const at = (ms) => app.sinceLaunch(r.origin + ms)
  // Interactive: the sidebar is shown and the main thread has had a second without long tasks since.
  let interactive = r.marks.sidebar
  for (const t of r.tasks) if (t.start < interactive + 1000 && t.start + t.ms > interactive) interactive = t.start + t.ms
  return {
    firstPaintMs: at(r.paint), windowShownMs: app.sinceLaunch(await app.main.evaluate('globalThis.__bench.shownAt')), sidebarShownMs: at(r.marks.sidebar), sidebarInteractiveMs: at(interactive),
    composerMs: at(r.marks.composer), largeSessionShownMs: at(r.marks.log),
    longTasks: r.tasks.length, longTaskMs: r.tasks.reduce((n, t) => n + t.ms, 0), maxLongTaskMs: Math.max(0, ...r.tasks.map((t) => t.ms)),
    tasks: r.tasks.map((t) => ({ atMs: Math.round(at(t.start)), ms: Math.round(t.ms) })),
    // Everything until the main thread settles, including history mounted in the background.
    busyUntilMs: at(Math.max(r.marks.log, ...r.tasks.map((t) => t.start + t.ms)))
  }
}

async function scenarioOpenLarge(app) {
  const r = await profiled(app, 'open-large', () => timedClick(app, 'openLarge', row(codeSession), shown(codeSession)))
  return r
}

async function scenarioSwitch(app) {
  const order = [mediums[0], mediums[1], imageSession, mediums[2], codeSession, mediums[0], imageSession, mediums[1]]
  const samples = []
  let current = codeSession
  for (const s of order) {
    if (s === current) continue
    samples.push((await timedClick(app, 'switch', row(s), shown(s))).ms)
    current = s
  }
  // Ends on the image-heavy session's neighbor; return to it for what follows.
  await timedClick(app, 'switch', row(imageSession), shown(imageSession))
  return stats(samples)
}

async function scenarioThread(app) {
  const t = firstThread(imageSession.id)
  // Scrolls up to its anchor, as the user would, when that part of the log isn't mounted yet.
  for (let i = 0; i < 100; i++) {
    const found = await app.renderer.evaluate(`(() => { const a = document.querySelector(${JSON.stringify(`.log .anchored[data-thread=${JSON.stringify(t.id)}]`)}); if (a) return true; const s = document.querySelector('.conversation .log-scroll'); s.scrollTop -= s.clientHeight; return false })()`)
    if (found) break
    await delay(150)
  }
  await settle(app, 500)
  return timedClick(app, 'openThread', `.log .anchored[data-thread=${JSON.stringify(t.id)}]`, `[data-message-id=${JSON.stringify(t.first)}]`)
}

async function scenarioSearch(app) {
  await key(app, 'f', 10) // Ctrl+Shift+F
  await waitFor(app, `document.querySelector('.search-field input')`)
  await app.renderer.evaluate(`document.querySelector('.search-field input').focus()`)
  const samples = []
  for (const query of ['reducer', 'boundary cache', 'toolCall', 'scroll paint frame']) {
    await app.renderer.evaluate(`(() => { const i = document.querySelector('.search-field input'); i.select(); })()`)
    await key(app, 'Backspace')
    await delay(400)
    const before = await app.renderer.evaluate(`document.querySelector('.search-dialog').innerText`)
    await app.renderer.evaluate(`window.__bench.marks.searchStart = performance.now(); window.__bench.searchBefore = ${JSON.stringify(before)}`)
    await app.renderer.send('Input.insertText', { text: query })
    await waitFor(app, `document.querySelector('.search-results .search-group') && document.querySelector('.search-dialog').innerText !== window.__bench.searchBefore && document.querySelector('.search-field input').value === ${JSON.stringify(query)}`, 10000)
    samples.push(await app.renderer.evaluate('performance.now() - window.__bench.marks.searchStart'))
  }
  await key(app, 'Escape')
  return stats(samples)
}

/**
 * The image-heavy session streams a long answer while the user types in the composer and
 * scrolls the log: frames, long tasks, input latency, main-process CPU and IPC per turn.
 */
async function scenarioStream(app) {
  await setAgent(app, { chars: 16000, chunk: [6, 18], intervalMs: 30, toolCalls: 3 })
  await settle(app, 1000)
  await click(app, '.conversation .composer .cm-content')
  await app.renderer.send('Input.insertText', { text: 'Walk me through the redesign once more, with code.' })
  const ipcBefore = await ipc(app)
  const cpuBefore = await mainCpu(app)
  const metricsBefore = await metrics(app)
  const started = Date.now()
  return profiled(app, 'stream', async () => {
    await phase(app, 'stream')
    await key(app, 'Enter', 0, '\r')
    await waitFor(app, `document.querySelector('.session-row.on .running-dot')`, 10000)
    await delay(2000)
    // Typing: a key every 120 ms for 6 s into the composer (left unsent).
    await phase(app, 'typing')
    await click(app, '.conversation .composer .cm-content')
    for (let i = 0; i < 50; i++) {
      await key(app, 'abcdefghij'[i % 10], 0, 'abcdefghij'[i % 10])
      await delay(120)
    }
    // Scrolling: up through the history and back, a wheel step per frame.
    await phase(app, 'scroll')
    const { x, y } = await center(app, '.conversation .log-scroll')
    for (let i = 0; i < 120; i++) {
      await app.renderer.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: i < 80 ? -240 : 360 })
      await delay(16)
    }
    await app.renderer.evaluate(`(() => { const s = document.querySelector('.conversation .log-scroll'); s.scrollTop = s.scrollHeight })()`)
    await phase(app, 'stream')
    await waitFor(app, `!document.querySelector('.session-row.on .running-dot')`, 120000)
    const wallMs = Date.now() - started
    await delay(300)
    const cpuAfter = await mainCpu(app)
    const ipcAfter = await ipc(app)
    const metricsAfter = await metrics(app)
    const summaries = { stream: await phaseSummary(app, 'stream'), typing: await phaseSummary(app, 'typing'), scroll: await phaseSummary(app, 'scroll') }
    const keyEvents = await app.renderer.evaluate(`window.__bench.events.filter((e) => e.phase === 'typing' && ['keydown', 'keypress', 'beforeinput', 'input'].includes(e.name)).map((e) => e.ms)`)
    // Clear the draft.
    await key(app, 'a', 2)
    await key(app, 'Backspace')
    await phase(app, 'idle')
    const all = [summaries.stream, summaries.typing, summaries.scroll]
    return {
      wallMs,
      mainCpuMs: cpuAfter - cpuBefore,
      mainCpuPercent: ((cpuAfter - cpuBefore) / wallMs) * 100,
      ipc: { count: ipcAfter.count - ipcBefore.count, bytes: ipcAfter.bytes - ipcBefore.bytes, byType: Object.fromEntries(Object.entries(ipcAfter.byType).map(([k, v]) => [k, { count: v.count - (ipcBefore.byType[k]?.count ?? 0), bytes: v.bytes - (ipcBefore.byType[k]?.bytes ?? 0) }])) },
      renderer: {
        longTasks: all.reduce((n, s) => n + s.longTasks, 0), longTaskMs: all.reduce((n, s) => n + s.longTaskMs, 0), maxLongTaskMs: Math.max(...all.map((s) => s.maxLongTaskMs)),
        scriptMs: (metricsAfter.ScriptDuration - metricsBefore.ScriptDuration) * 1000,
        layoutMs: (metricsAfter.LayoutDuration - metricsBefore.LayoutDuration) * 1000, layouts: metricsAfter.LayoutCount - metricsBefore.LayoutCount,
        styleMs: (metricsAfter.RecalcStyleDuration - metricsBefore.RecalcStyleDuration) * 1000
      },
      phases: summaries,
      // Event Timing records only events over 16 ms; fewer than the 50 keys means the rest were faster.
      slowKeyEvents: stats(keyEvents)
    }
  })
}

/** A compressed hour: switching, scrolling every image into view, threads, searches and short turns. */
async function scenarioSoak(app) {
  const before = await memory(app)
  const end = Date.now() + soakMinutes * 60_000
  let cycles = 0
  await setAgent(app, { chars: 3000, chunk: [6, 18], intervalMs: 10, toolCalls: 1 })
  while (Date.now() < end) {
    for (const s of [codeSession, mediums[cycles % 3], imageSession]) await timedClick(app, 'soak', row(s), shown(s))
    // Scroll the image-heavy session to the top and back, so every image is decoded once.
    await app.renderer.evaluate(`(async () => { const s = document.querySelector('.conversation .log-scroll'); for (let y = s.scrollHeight; y > 0; y -= 1500) { s.scrollTop = y; await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 15))) } s.scrollTop = 0; await new Promise((r) => setTimeout(r, 300)); s.scrollTop = s.scrollHeight })()`)
    await scenarioThread(app).catch(() => {})
    await key(app, 'Escape')
    await click(app, '.conversation .composer .cm-content')
    await app.renderer.send('Input.insertText', { text: `bench:short turn ${cycles}` })
    await key(app, 'Enter', 0, '\r')
    await waitFor(app, `document.querySelector('.session-row.on .running-dot')`, 10000).catch(() => {})
    await waitFor(app, `!document.querySelector('.session-row.on .running-dot')`, 60000)
    cycles++
  }
  await settle(app, 1000)
  const after = await memory(app)
  return { minutes: soakMinutes, cycles, before, after, growth: { rendererHeapMB: after.rendererHeapMB - before.rendererHeapMB, rendererWorkingSetMB: after.rendererWorkingSetMB - before.rendererWorkingSetMB, mainHeapMB: after.mainHeapMB - before.mainHeapMB, totalWorkingSetMB: after.totalWorkingSetMB - before.totalWorkingSetMB } }
}

// --- Run --------------------------------------------------------------------------

const result = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  machine: machineId(),
  environment: { platform: process.platform, os: release(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), electron: require('electron/package.json').version },
  app: appDir === root ? null : appDir,
  seed: { ...seeded.summary, dbMB: dbBytes / 1048576 },
  bundle: bundleSizes(),
  startup: [],
  scenarios: {}
}

function bundleSizes() {
  const size = (dir, filter = () => true) => readdirSync(join(appDir, dir), { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && filter(f.name)).reduce((n, f) => n + readFileSync(join(f.parentPath, f.name)).length, 0) / 1024
  return { mainKB: size('out/main'), preloadKB: size('out/preload'), rendererKB: size('out/renderer'), rendererScriptKB: size('out/renderer', (n) => n.endsWith('.js')) }
}

try {
  for (let i = 0; i < rounds && wanted('startup'); i++) {
    console.log(`Startup ${i + 1}/${rounds}…`)
    const app = await launch(`startup-${i}`)
    try {
      result.startup.push(await startup(app))
      if (values.profile && i === 0) {
        const profile = await app.main.evaluate('globalThis.__bench.profiling.debugger.sendCommand("Profiler.stop").then((r) => JSON.stringify(r.profile))')
        mkdirSync(join(outDir, 'profiles'), { recursive: true })
        writeFileSync(join(outDir, 'profiles', 'startup.renderer.cpuprofile'), profile)
        writeFileSync(join(outDir, 'profiles', 'startup.main.cpuprofile'), JSON.stringify((await app.main.send('Profiler.stop')).profile))
      }
      if (i === 0) result.startupMemory = await memory(app)
    } catch (err) {
      console.error(app.log().slice(-4000))
      throw err
    } finally {
      await quit(app)
    }
  }
  console.log('Scenarios…')
  const app = await launch('scenarios')
  try {
    await waitFor(app, `document.querySelector(${JSON.stringify(shown(imageSession))})`, 60000)
    await settle(app, 2000, 60000)
    const steps = [['openLarge', scenarioOpenLarge], ['switch', scenarioSwitch], ['thread', scenarioThread], ['search', scenarioSearch], ['stream', scenarioStream], ['soak', scenarioSoak]]
    for (const [name, fn] of steps) {
      if (!wanted(name)) continue
      console.log(`  ${name}`)
      result.scenarios[name] = await fn(app)
    }
  } catch (err) {
    console.error(app.log().slice(-4000))
    throw err
  } finally {
    await quit(app)
  }
} finally {
  writeFileSync(resolve(values.output), JSON.stringify(result, null, 2) + '\n')
}

result.summary = summarize(result)
writeFileSync(resolve(values.output), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result.summary, null, 2))
console.log(`Results: ${resolve(values.output)}`)

/** The headline numbers the baseline compares; lower is better for all of them. */
function summarize(r) {
  const median = (xs) => stats(xs).p50
  const s = r.scenarios
  return Object.fromEntries(Object.entries({
    'startup.windowShownMs': median(r.startup.map((x) => x.windowShownMs)),
    'startup.firstPaintMs': median(r.startup.map((x) => x.firstPaintMs)),
    'startup.sidebarInteractiveMs': median(r.startup.map((x) => x.sidebarInteractiveMs)),
    'startup.largeSessionShownMs': median(r.startup.map((x) => x.largeSessionShownMs)),
    'startup.busyUntilMs': median(r.startup.map((x) => x.busyUntilMs)),
    'openLarge.ms': s.openLarge?.ms,
    'openLarge.busyUntilMs': s.openLarge?.busyUntilMs,
    'switch.p50Ms': s.switch?.p50,
    'switch.p95Ms': s.switch?.p95,
    'thread.ms': s.thread?.ms,
    'search.p50Ms': s.search?.p50,
    'stream.mainCpuMs': s.stream?.mainCpuMs,
    'stream.ipcKB': s.stream ? s.stream.ipc.bytes / 1024 : undefined,
    'stream.rendererScriptMs': s.stream?.renderer.scriptMs,
    'stream.rendererLongTaskMs': s.stream?.renderer.longTaskMs,
    'stream.maxLongTaskMs': s.stream?.renderer.maxLongTaskMs,
    'stream.typingFrameP95Ms': s.stream?.phases.typing.frameP95Ms,
    'stream.scrollFrameP95Ms': s.stream?.phases.scroll.frameP95Ms,
    'soak.rendererWorkingSetMB': s.soak?.after.rendererWorkingSetMB,
    'soak.totalWorkingSetMB': s.soak?.after.totalWorkingSetMB,
    'bundle.rendererScriptKB': r.bundle.rendererScriptKB,
    'bundle.mainKB': r.bundle.mainKB
  }).filter(([, v]) => typeof v === 'number'))
}

if (!values['no-compare']) {
  const baselineFile = join(root, 'docs/performance/baselines', `${result.machine}.json`)
  if (values['update-baseline']) {
    mkdirSync(dirname(baselineFile), { recursive: true })
    writeFileSync(baselineFile, JSON.stringify({ machine: result.machine, measuredAt: result.measuredAt, environment: result.environment, summary: result.summary }, null, 2) + '\n')
    console.log(`Baseline updated: ${baselineFile}`)
  } else if (existsSync(baselineFile)) {
    const failures = compare(JSON.parse(readFileSync(baselineFile, 'utf8')).summary, result.summary, result)
    for (const f of failures) console.error(`FAIL ${f}`)
    if (failures.length) process.exitCode = 1
    else console.log('Within the baseline.')
  } else console.log(`No baseline for ${result.machine}; record one with --update-baseline.`)
}
