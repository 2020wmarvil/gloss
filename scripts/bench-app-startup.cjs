// Runs only as a benchmark child. Never opens the live Gloss database for writes.
/* global require, process, console, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
const { copyFileSync, existsSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
if (process.argv[2] === 'prepare') {
  const { DatabaseSync, backup } = require('node:sqlite')
  const source = process.argv[3]
  const destination = process.argv[4]
  const db = new DatabaseSync(join(source, 'gloss.db'), { readOnly: true })
  backup(db, join(destination, 'gloss.db')).then(() => {
    db.close()
    if (existsSync(join(source, 'settings.json'))) copyFileSync(join(source, 'settings.json'), join(destination, 'settings.json'))
  }).catch(() => { process.exitCode = 1 })
} else {
  profile().catch((error) => {
    console.error(`BENCH_ERROR ${error.message}`)
    require('electron').app.exit(1)
  })
}

async function profile() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { performance } = require('node:perf_hooks')
  const launchedAt = Number(process.env.GLOSS_BENCH_LAUNCHED_AT)
  const elapsed = () => Date.now() - launchedAt
  app.setPath('userData', process.env.GLOSS_BENCH_DATA)
  let selectedId
  if (process.env.GLOSS_BENCH_LARGEST) {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(join(process.env.GLOSS_BENCH_DATA, 'gloss.db'), { readOnly: true })
    selectedId = db.prepare('SELECT session_id FROM messages GROUP BY session_id ORDER BY SUM(length(text)) DESC LIMIT 1').get()?.session_id
    db.close()
  }
  if (process.env.GLOSS_BENCH_RENDERER) {
    const original = BrowserWindow.prototype.loadFile
    BrowserWindow.prototype.loadFile = function (file, ...args) {
      return original.call(this, join(process.env.GLOSS_BENCH_RENDERER, 'index.html'), ...args)
    }
  }
  const result = { environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform }, ipc: [], phases: {} }
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
    const start = performance.now()
    const enteredMs = elapsed()
    let value = await listener(...args)
    if (selectedId && channel === 'gloss:sessions:list') value = [...value].sort((a,b) => Number(b.id === selectedId) - Number(a.id === selectedId))
    result.ipc.push({ channel, enteredMs, ms: performance.now() - start })
    if (channel === 'gloss:sessions:open') result.restored = {
      messages: value.messages.length, tools: value.toolCalls.length, threads: value.threads.length,
      textChars: value.messages.reduce((n, m) => n + m.text.length, 0), review: Boolean(value.session.review)
    }
    return value
  })
  let resolveContents
  const created = new Promise((resolve) => { resolveContents = resolve })
  app.once('web-contents-created', (_event, contents) => {
    contents.debugger.attach('1.3')
    const send = (method, args) => contents.debugger.sendCommand(method, args)
    const instrumentation = `(() => {
      if (window.__glossPerf) return;
      const p = window.__glossPerf = { tasks: [], frames: [], composer: null, phase: 'startup' };
      new PerformanceObserver(list => { for (const e of list.getEntries()) p.tasks.push({ start: e.startTime, ms: e.duration, phase: p.phase }); }).observe({ type: 'longtask', buffered: true });
      let last = performance.now();
      function frame(now) { p.frames.push({ start: now, ms: now-last, phase: p.phase }); last = now; requestAnimationFrame(frame); }
      requestAnimationFrame(frame);
      const observer = new MutationObserver(() => { if (p.composer !== null) return; const el = document.querySelector('.composer .cm-content'); if (el) { p.composer = performance.now(); requestAnimationFrame(() => { p.composerPaint = performance.now(); }); } });
      observer.observe(document, { childList: true, subtree: true });
    })()`
    const setup = Promise.all([
      send('Page.enable').then(() => send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation, runImmediately: true })),
      send('Performance.enable'),
      send('Profiler.enable').then(() => send('Profiler.start'))
    ])
    contents.once('dom-ready', () => { result.phases.domReadyMs = elapsed() })
    contents.once('did-finish-load', () => { result.phases.didFinishLoadMs = elapsed() })
    resolveContents({ contents, send, setup })
  })
  app.once('browser-window-created', (_event, win) => {
    result.phases.windowCreatedMs = elapsed()
    win.once('show', () => { result.windowShownMs = elapsed() })
  })
  const beforeRequire = performance.now()
  require(resolve('out/main/index.js'))
  result.phases.mainModuleMs = performance.now() - beforeRequire
  await app.whenReady()
  result.phases.appReadyMs = elapsed()
  const { contents, send, setup } = await created
  await setup
  const evaluate = (expression) => contents.executeJavaScript(expression)
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // A fixed observation interval includes delayed highlighting and background session refresh.
  await delay(10000)
  const first = await evaluate(`(() => { const p=window.__glossPerf; return { ...p, origin: performance.timeOrigin, paints: performance.getEntriesByType('paint').map(e=>({name:e.name,ms:e.startTime})), domNodes: document.querySelectorAll('*').length, codeBlocks: document.querySelectorAll('pre').length, resources: performance.getEntriesByType('resource').filter(e=>['script','link'].includes(e.initiatorType)).map(e=>({ file: new URL(e.name).pathname.split('/').pop(), startMs: e.startTime, ms: e.duration, bytes: e.decodedBodySize })).sort((a,b)=>b.ms-a.ms).slice(0,15) }; })()`)
  if (!first.tasks) throw new Error('Renderer instrumentation missing')
  result.composerMs = first.composerPaint == null ? null : first.origin + first.composerPaint - launchedAt
  result.paints = first.paints
  result.domNodes = first.domNodes
  result.codeBlocks = first.codeBlocks
  result.resources = first.resources
  const cpu = (await send('Profiler.stop')).profile
  result.startup = summarize(first, 'startup')
  result.startup.tasks = first.tasks.map((e) => ({ startMs: first.origin + e.start - launchedAt, ms: e.ms }))
  result.startup.cpu = summarizeCpu(cpu)
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const before = await metrics()
  await evaluate(`window.__glossPerf.phase = 'resize'`)
  await send('Profiler.start')
  const win = BrowserWindow.fromWebContents(contents)
  const begin = performance.now()
  for (let i = 0; i < 120; i++) {
    const width = Math.round(1100 + 180 * Math.sin(i * Math.PI / 30))
    win.setSize(width, 820)
    await delay(16)
  }
  await delay(300)
  const last = await evaluate('window.__glossPerf')
  result.resize = summarize(last, 'resize')
  result.resize.wallMs = performance.now() - begin
  result.resize.cpu = summarizeCpu((await send('Profiler.stop')).profile)
  const after = await metrics()
  result.resize.metrics = Object.fromEntries(['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map((key) => [key, after[key] - before[key]]))
  result.rendererMemory = app.getAppMetrics().find((m) => m.pid === contents.getOSProcessId())?.memory
  writeFileSync(process.env.GLOSS_BENCH_RESULT, JSON.stringify(result, null, 2) + '\n')
  // No prompts were sent. Use normal teardown so the application disposes its adapters.
  app.quit()
}

function summarize(data, phase) {
  const tasks = data.tasks.filter((e) => e.phase === phase)
  const frames = data.frames.filter((e) => e.phase === phase).map((e) => e.ms).sort((a, b) => a-b)
  return { longTasks: tasks.length, totalLongTaskMs: tasks.reduce((n, e) => n + e.ms, 0), maxLongTaskMs: Math.max(0, ...tasks.map((e) => e.ms)), frameP95Ms: frames[Math.max(0, Math.ceil(frames.length * .95)-1)] ?? 0, maxFrameMs: frames.at(-1) ?? 0, frames: frames.length, framesOver50Ms: frames.filter((ms) => ms > 50).length }
}

function summarizeCpu(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const counts = new Map()
  for (let i = 0; i < (profile.samples ?? []).length; i++) {
    const node = nodes.get(profile.samples[i])
    const name = node.callFrame.functionName || '(anonymous)'
    const key = `${name}:${node.callFrame.lineNumber + 1}`
    const entry = counts.get(key) ?? { name, line: node.callFrame.lineNumber + 1, ms: 0 }
    entry.ms += (profile.timeDeltas[i] ?? 0) / 1000
    counts.set(key, entry)
  }
  return [...counts.values()].sort((a,b) => b.ms-a.ms).slice(0, 25)
}
