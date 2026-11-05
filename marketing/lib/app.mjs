/* global process, setTimeout, fetch, WebSocket, Buffer */
// Drives the built Gloss over CDP: a scratch data folder, Haiku, and the signed-in agent's own login.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

/** The environment of a fresh terminal, so the agent uses the real login rather than a host session's. */
function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|ELECTRON_|GLOSS_)/i.test(key)) continue
    env[key] = value
  }
  env.ANTHROPIC_MODEL = 'haiku'
  return env
}

/** One CDP target (a window). */
class Target {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) fail(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? '')})`))
        else ok(m.result)
      } else if (m.method) this.listeners.get(m.method)?.forEach((f) => f(m.params))
    })
    // A window that closes fails what was waiting on it, rather than leaving the run hanging.
    ws.addEventListener('close', () => {
      for (const { fail } of this.pending.values()) fail(new Error('The window closed during capture.'))
      this.pending.clear()
    })
  }

  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true })
      ws.addEventListener('error', fail, { once: true })
    })
    return new Target(ws)
  }

  send(method, params = {}) {
    return new Promise((ok, fail) => {
      const id = ++this.id
      this.pending.set(id, { ok, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(listener)
    return () => this.listeners.get(method).delete(listener)
  }

  /** Evaluates an expression (or an async function body with `async: true` wrapping) in the page. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(`${exceptionDetails.exception?.description ?? exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`)
    return result.value
  }

  async waitFor(expression, { timeout = 30000, label } = {}) {
    const end = Date.now() + timeout
    for (;;) {
      const value = await this.eval(expression)
      if (value) return value
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label ?? expression}`)
      await sleep(100)
    }
  }

  async setSize(width, height, scale) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
  }

  async screenshot(file) {
    // No captureBeyondViewport: it resizes the viewport, and Gloss closes its menus on resize.
    const { cssLayoutViewport: v } = await this.send('Page.getLayoutMetrics')
    const clip = { x: 0, y: 0, width: v.clientWidth, height: v.clientHeight, scale: 1 }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }

  close() {
    this.ws.close()
  }
}

export class App {
  constructor(proc, port, dataDir) {
    this.proc = proc
    this.port = port
    this.dataDir = dataDir
  }

  async targets() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`)
    return (await res.json()).filter((t) => t.type === 'page')
  }

  /** Opens the first page target whose URL passes `match`. */
  async window(match = (url) => /index\.html$/.test(url), timeout = 30000) {
    const end = Date.now() + timeout
    for (;;) {
      const found = (await this.targets().catch(() => [])).find((t) => match(t.url))
      if (found) {
        const target = await Target.open(found.webSocketDebuggerUrl)
        await target.send('Page.enable')
        await target.send('Runtime.enable')
        return target
      }
      if (Date.now() > end) throw new Error('No matching Gloss window')
      await sleep(150)
    }
  }

  async quit() {
    this.proc.kill()
    await sleep(800)
    // The adapter's children can hold the folder for a moment.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.dataDir, { recursive: true, force: true })
        return
      } catch {
        await sleep(500)
      }
    }
  }
}

/** Opens an HTML file in a bare window. Returns the page and a function that closes it. */
export async function openPage(file, { width, height, scale = 1, port = 9344 }) {
  const data = mkdtempSync(join(tmpdir(), 'gloss-page-'))
  const host = join(ROOT, 'marketing', 'lib', 'page-host.cjs')
  const proc = spawn(ELECTRON, [host, `--user-data-dir=${data}`, `--remote-debugging-port=${port}`, resolve(file), String(width), String(height)], { env: cleanEnv(), stdio: 'ignore' })
  const app = new App(proc, port, data)
  const page = await app.window((url) => url.startsWith('file:'))
  await page.setSize(width, height, scale)
  await page.waitFor(`document.readyState === 'complete' && document.fonts.status === 'loaded'`)
  return { page, close: () => app.quit() }
}

export async function launch({ port = 9333, settings = {}, dataDir, args = [] } = {}) {
  const data = dataDir ?? mkdtempSync(join(tmpdir(), 'gloss-marketing-'))
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ permissionMode: 'bypass', ...settings }))
  const proc = spawn(ELECTRON, [ROOT, `--user-data-dir=${data}`, `--remote-debugging-port=${port}`, ...args], { env: cleanEnv(), stdio: 'ignore' })
  return new App(proc, port, data)
}
