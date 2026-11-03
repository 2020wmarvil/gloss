// Compares a benchmark run with this machine's baseline (docs/performance/README.md).
import { cpus, platform } from 'node:os'
import process from 'node:process'
import console from 'node:console'

/** Generous on purpose: wall-clock numbers vary between runs even on one machine. */
export const MARGIN = 1.25
/** Long tasks while streaming always fail, baseline or not. */
export const STREAM_LONG_TASK_MS = 50

/** Names the machine by its hardware, so a baseline is only compared with its own machine. */
export function machineId() {
  const cpu = (cpus()[0]?.model ?? 'cpu').toLowerCase().replace(/\(r\)|\(tm\)|cpu|@.*$/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${platform()}-${cpu}-${cpus().length}t`
}

/** Absolute slack per unit, so tiny values don't fail on noise (5 ms becoming 8 ms). */
function slack(name) {
  if (name.endsWith('KB')) return 64
  if (name.endsWith('MB')) return 40
  return 25
}

export function compare(baseline, current, result) {
  const failures = []
  for (const [name, base] of Object.entries(baseline)) {
    const now = current[name]
    if (typeof now !== 'number' || typeof base !== 'number') continue
    if (now > base * MARGIN && now - base > slack(name)) failures.push(`${name}: ${now.toFixed(1)} vs baseline ${base.toFixed(1)} (+${Math.round((now / base - 1) * 100)}%)`)
  }
  const stream = result?.scenarios?.stream
  if (stream && stream.renderer.maxLongTaskMs > STREAM_LONG_TASK_MS) failures.push(`stream: a renderer long task took ${stream.renderer.maxLongTaskMs.toFixed(0)} ms (limit ${STREAM_LONG_TASK_MS} ms)`)
  return failures
}

// node scripts/bench/compare.mjs <before.json> <after.json>: a markdown table of the two runs' headline numbers.
if (process.argv[1]?.endsWith('compare.mjs') && process.argv.length === 4) {
  const { readFileSync } = await import('node:fs')
  const [before, after] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')).summary)
  const fmt = (n) => (n === undefined ? '' : n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1))
  console.log('| Metric | Before | After | Change |\n| --- | ---: | ---: | ---: |')
  for (const key of Object.keys({ ...before, ...after })) {
    const b = before[key]
    const a = after[key]
    const change = b && a !== undefined ? `${a <= b ? '−' : '+'}${Math.abs(Math.round((a / b - 1) * 100))}%` : ''
    console.log(`| ${key} | ${fmt(b)} | ${fmt(a)} | ${change} |`)
  }
}
