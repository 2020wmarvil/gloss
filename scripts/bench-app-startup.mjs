// Profile the built application in fresh Electron processes using a SQLite snapshot.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, release } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'

const require = createRequire(import.meta.url)
const { values } = parseArgs({ options: {
  rounds: { type: 'string', default: '5' },
  'source-data': { type: 'string', default: join(process.env.APPDATA ?? '', 'gloss') },
  output: { type: 'string', default: 'out/bench-app-startup/results.json' },
  empty: { type: 'boolean', default: false },
  dev: { type: 'boolean', default: false },
  'largest-session': { type: 'boolean', default: false },
  variant: { type: 'string', default: 'baseline' },
  'skip-build': { type: 'boolean', default: false }
} })
const rounds = Number(values.rounds)
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('Invalid rounds')
if (!['baseline', 'no-react-resize', 'no-highlight'].includes(values.variant) || (values.dev && values.variant !== 'baseline')) throw new Error('Invalid variant (diagnostic variants require a built renderer)')
const electron = require('electron')
const runner = resolve('scripts/bench-app-startup.cjs')
const output = resolve(values.output)
mkdirSync(dirname(output), { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'gloss-app-bench-'))
async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    child.stdout.on('data', (b) => { diagnostics += b })
    child.stderr.on('data', (b) => { diagnostics += b })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Benchmark subprocess timed out')) }, 60000)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Benchmark subprocess failed (${code}). Diagnostics suppressed to keep native configuration private. ${diagnostics.includes('BENCH_ERROR') ? diagnostics.slice(diagnostics.lastIndexOf('BENCH_ERROR'), diagnostics.lastIndexOf('BENCH_ERROR') + 250) : ''}`))
    })
  })
}
const samples = []
function save() {
  const fields = {
    windowShownMs: (s) => s.windowShownMs,
    composerMs: (s) => s.composerMs,
    startupMaxLongTaskMs: (s) => s.startup.maxLongTaskMs,
    startupTotalLongTaskMs: (s) => s.startup.totalLongTaskMs,
    resizeFrameP95Ms: (s) => s.resize.frameP95Ms,
    resizeScriptMs: (s) => s.resize.metrics.ScriptDuration * 1000,
    resizeTaskMs: (s) => s.resize.metrics.TaskDuration * 1000
  }
  const summaries = Object.fromEntries(Object.entries(fields).map(([name, get]) => {
    const list = samples.map(get).filter((n) => n != null).sort((a,b) => a-b)
    return [name, { count: list.length, mean: list.length ? list.reduce((a,b) => a+b,0)/list.length : null, p50: list[Math.ceil(list.length*.5)-1] ?? null, min: list[0] ?? null, max: list.at(-1) ?? null }]
  }))
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, os: release() }, scenario: values.empty ? 'empty' : 'snapshot', mode: values.dev ? 'dev' : 'built', selection: values['largest-session'] ? 'largest' : 'latest', variant: values.variant, summaries, samples }, null, 2) + '\n')
}
try {
  if (!values['skip-build']) {
    console.log('Building application (outside measured interval)…')
    await run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
  }
  const snapshot = join(scratch, 'snapshot')
  mkdirSync(snapshot)
  if (!values.empty) await run(electron, [runner, 'prepare', resolve(values['source-data']), snapshot], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  let renderer
  if (values.variant !== 'baseline') {
    renderer = join(scratch, 'renderer')
    cpSync(resolve('out/renderer'), renderer, { recursive: true })
    const html = readFileSync(join(renderer, 'index.html'), 'utf8')
    const asset = join(renderer, /src="\.\/(assets\/index-[^"]+\.js)"/.exec(html)[1])
    const original = readFileSync(asset, 'utf8')
    const modified = values.variant === 'no-react-resize'
      ? original.replace('const onResize = () => setWidth(window.innerWidth);', 'const onResize = () => {};')
      : original.replace(/const ready = createHighlighterCore\([\s\S]*?(?=function useHighlighting\()/, 'const ready = Promise.resolve();\n')
    if (modified === original) throw new Error('Diagnostic variant no longer matches the bundle')
    writeFileSync(asset, modified)
  }
  for (let round = 1; round <= rounds; round++) {
    const dataDir = join(scratch, `round-${round}`)
    mkdirSync(dataDir)
    for (const file of ['gloss.db', 'settings.json']) if (existsSync(join(snapshot, file))) copyFileSync(join(snapshot, file), join(dataDir, file))
    const result = join(dataDir, 'result.json')
    let server
    if (values.dev) {
      const { createServer } = await import('vite')
      const { default: react } = await import('@vitejs/plugin-react')
      server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()], resolve: { alias: { '@shared': resolve('src/shared') } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
      await server.listen()
    }
    const env = { ...process.env, GLOSS_BENCH_DATA: dataDir, GLOSS_BENCH_RESULT: result, GLOSS_BENCH_LAUNCHED_AT: String(Date.now()), GLOSS_BENCH_RENDERER: renderer ?? '', GLOSS_BENCH_LARGEST: values['largest-session'] ? '1' : '' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    if (server) env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0]
    try { await run(electron, [runner], env) } finally { await server?.close() }
    const sample = JSON.parse(readFileSync(result, 'utf8'))
    samples.push(sample)
    save()
    const composer = sample.composerMs == null ? 'not shown' : `${Math.round(sample.composerMs)} ms`
    console.log(`Round ${round}/${rounds}: window ${Math.round(sample.windowShownMs)} ms, composer ${composer}, startup longest task ${Math.round(sample.startup.maxLongTaskMs)} ms, resize frame p95 ${Math.round(sample.resize.frameP95Ms)} ms`)
  }
  console.log(`Results: ${output}`)
} finally {
  const target = resolve(scratch)
  if (target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('gloss-app-bench-')) rmSync(target, { recursive: true, force: true })
  else console.error('Refusing unsafe benchmark cleanup')
}
