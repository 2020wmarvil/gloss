// M18 spike: can Electron's Node serve the phone over HTTPS with a Tailscale certificate,
// hold a WebSocket to it, and reach it with web push (iOS needs the page added to the Home Screen)?
//
// ELECTRON_RUN_AS_NODE=1 electron scripts/probe-bridge.mjs <scratch dir> [push]
// The scratch dir holds cert.pem/key.pem from `tailscale cert`, and node_modules with ws and web-push.
// `push` sends a test notification to the subscriptions saved by an earlier run, then exits.
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import process from 'node:process'
import { URL } from 'node:url'
import { setInterval, clearInterval, setTimeout } from 'node:timers'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: probe-bridge.mjs <scratch dir> [push]')
const require = createRequire(join(dir, 'deps', 'package.json'))
const { WebSocketServer } = require('ws')
const webpush = require('web-push')

const tailscale = 'C:/Program Files/Tailscale/tailscale.exe'
const status = JSON.parse(execFileSync(tailscale, ['status', '--json'], { encoding: 'utf8' }))
const host = status.CertDomains[0]
const ip = status.Self.TailscaleIPs.find((a) => a.includes('.'))
const port = 8443

const vapidFile = join(dir, 'vapid.json')
if (!existsSync(vapidFile)) writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()))
const vapid = JSON.parse(readFileSync(vapidFile, 'utf8'))
// Apple's push service answers 403 BadJwtToken for a `mailto:` at a reserved domain like example.invalid.
webpush.setVapidDetails(`https://${host}`, vapid.publicKey, vapid.privateKey)

const subsFile = join(dir, 'subs.json')
const subs = existsSync(subsFile) ? JSON.parse(readFileSync(subsFile, 'utf8')) : []

async function push(body) {
  for (const sub of subs) {
    const t = Date.now()
    try {
      const r = await webpush.sendNotification(sub, JSON.stringify({ title: 'Gloss probe', body }))
      console.log(`push ${new URL(sub.endpoint).host}: ${r.statusCode} in ${Date.now() - t} ms`)
    } catch (e) {
      console.log(`push ${new URL(sub.endpoint).host} failed: ${e.statusCode} ${e.body ?? e.message}`)
    }
  }
}

if (process.argv[3] === 'push') {
  await push(`Test push at ${new Date().toLocaleTimeString()}`)
  process.exit(0)
}

const page = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<title>Gloss probe</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:24px;background:#111;color:#eee}button{font-size:18px;padding:12px 16px}pre{white-space:pre-wrap;font-size:13px}</style>
</head><body>
<h2>Gloss probe</h2>
<p id="mode"></p>
<button id="sub">Enable notifications</button>
<pre id="log"></pre>
<script>
const log = (s) => { document.getElementById('log').textContent += new Date().toLocaleTimeString() + ' ' + s + '\\n' }
document.getElementById('mode').textContent = 'standalone: ' + (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true)
  + ', serviceWorker: ' + ('serviceWorker' in navigator) + ', PushManager: ' + ('PushManager' in window) + ', Notification: ' + ('Notification' in window)
let ws
function connect() {
  ws = new WebSocket('wss://' + location.host + '/ws')
  ws.onopen = () => log('ws open')
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'tick') ws.send(JSON.stringify({ type: 'tock', n: m.n })); else log('ws ' + e.data) }
  ws.onclose = () => { log('ws closed, retrying in 2 s'); setTimeout(connect, 2000) }
}
connect()
navigator.serviceWorker?.register('/sw.js').then(() => log('sw registered'), (e) => log('sw failed: ' + e))
document.getElementById('sub').onclick = async () => {
  try {
    const perm = await Notification.requestPermission()
    log('permission: ' + perm)
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: '${vapid.publicKey}' })
    ws.send(JSON.stringify({ type: 'subscribe', sub: sub.toJSON() }))
    log('subscribed: ' + new URL(sub.endpoint).host + '. Push in 10 s: lock the phone or switch apps.')
  } catch (e) { log('subscribe failed: ' + e) }
}
</script>
</body></html>`

const sw = `self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'Gloss probe', body: '(no data)' }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body }))
})
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(clients.openWindow('/')) })`

// D8: does a Home Screen app see what Safari stored, and does its start address keep the pairing code?
// Open /pair?code=<x> in Safari, save a token, add it to the Home Screen, open it from there.
const pairPage = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="/icon.png">
<title>Gloss pair test</title>
<script>document.write('<link rel="manifest" href="/pair-manifest.json' + location.search + '">')</script>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:24px;background:#111;color:#eee}button{font-size:18px;padding:12px 16px;margin:6px 0}pre{white-space:pre-wrap;font-size:13px}</style>
</head><body>
<h2>Gloss pair test</h2>
<pre id="out"></pre>
<button id="save">Save token here</button>
<script>
const cookie = (document.cookie.match(/gloss-token=([^;]+)/) || [])[1] || null
const report = { type: 'report', href: location.href, standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,
  localStorage: localStorage.getItem('gloss-token'), cookie }
document.getElementById('out').textContent = JSON.stringify(report, null, 2)
document.getElementById('save').onclick = () => {
  const v = (report.standalone ? 'app-' : 'safari-') + Date.now()
  localStorage.setItem('gloss-token', v)
  document.cookie = 'gloss-token=' + v + '; path=/; max-age=31536000; secure; samesite=strict'
  location.reload()
}
const ws = new WebSocket('wss://' + location.host + '/ws')
ws.onopen = () => ws.send(JSON.stringify(report))
</script>
</body></html>`

const pairManifest = (search) => JSON.stringify({ name: 'Gloss pair test', short_name: 'Pair test', id: '/pair-test', start_url: `/pair${search}`, scope: '/', display: 'standalone', background_color: '#111111', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] })

const manifest = JSON.stringify({ name: 'Gloss probe', short_name: 'Gloss', start_url: '/', display: 'standalone', background_color: '#111111', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] })
const icon = readFileSync(new URL('../build/icon.png', import.meta.url))

const server = createServer({ cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) }, (req, res) => {
  console.log(`${req.method} ${req.url} ${req.headers['user-agent']?.slice(0, 60)}`)
  const send = (type, body) => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
  if (req.url === '/') send('text/html', page)
  else if (req.url === '/sw.js') send('text/javascript', sw)
  else if (req.url === '/manifest.json') send('application/manifest+json', manifest)
  else if (req.url === '/icon.png') send('image/png', icon)
  else if (req.url.startsWith('/pair-manifest.json')) send('application/manifest+json', pairManifest(req.url.slice('/pair-manifest.json'.length)))
  else if (req.url === '/pair' || req.url.startsWith('/pair?')) send('text/html', pairPage)
  else res.writeHead(404).end()
})

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  console.log('ws connected')
  let n = 0
  const sent = new Map()
  const timer = setInterval(() => { sent.set(++n, Date.now()); ws.send(JSON.stringify({ type: 'tick', n })) }, 5000)
  ws.on('message', (data) => {
    const m = JSON.parse(String(data))
    if (m.type === 'tock') console.log(`ws round trip ${Date.now() - sent.get(m.n)} ms`)
    if (m.type === 'report') console.log(`pair report ${JSON.stringify(m)}`)
    if (m.type === 'subscribe') {
      if (!subs.some((s) => s.endpoint === m.sub.endpoint)) subs.push(m.sub)
      writeFileSync(subsFile, JSON.stringify(subs, null, 2))
      console.log(`subscription from ${new URL(m.sub.endpoint).host}`)
      setTimeout(() => void push('It works: a push from the desktop.'), 10000)
    }
  })
  ws.on('close', () => { clearInterval(timer); console.log('ws closed') })
})

server.listen(port, ip, () => console.log(`https://${host}:${port}/ (listening on ${ip} only)`))
