/* global process */
// A small, believable project for the agent to work on. Written fresh for each capture run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'

/** At the drive root on Windows, so no user name shows up in a captured path. */
export const DEMO_PATH = process.platform === 'win32' ? join(parse(homedir()).root, 'gloss-demo', 'trailmap') : '/tmp/gloss-demo/trailmap'

// Two bugs to pin in the visual feedback scene: the badge hangs off its card, and the button is unreadable.
const STYLE = `body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #eef3ee; color: #1d2b22; }
header { background: #1f5138; color: #fff; padding: 28px 48px; }
h1 { margin: 0; font-size: 30px; }
main { max-width: 760px; margin: 32px auto; padding: 0 24px; }
.search { display: flex; gap: 8px; margin-bottom: 24px; }
.search input { flex: 1; padding: 12px 14px; border: 1px solid #b9c7bd; border-radius: 8px; font: inherit; }
.search button { padding: 12px 22px; border: 0; border-radius: 8px; background: #dfe7e1; color: #e8eee9; font: inherit; }
ul { list-style: none; margin: 0; padding: 0; }
li { position: relative; background: #fff; border-radius: 10px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 1px 3px #0002; }
li b { display: block; font-size: 18px; }
li small { color: #5c6d62; }
li .miles { position: absolute; right: -34px; top: 22px; background: #1f5138; color: #fff; padding: 4px 12px; border-radius: 999px; font-size: 14px; }
`

/** What public/index.html shows with the trails loaded, as a page of its own for the screenshot. */
export const DEMO_PAGE = `<!doctype html><meta charset="utf-8"><title>trailmap</title><style>${STYLE}</style>
<header><h1>Trails</h1></header>
<main>
  <div class="search"><input placeholder="Search trails"><button>Search</button></div>
  <ul>
    <li><b>Ridgeback Loop</b><small>410 ft of climbing</small><span class="miles">6.2 mi</span></li>
    <li><b>Fern Hollow</b><small>95 ft of climbing</small><span class="miles">3.1 mi</span></li>
    <li><b>Eagle Saddle</b><small>1,180 ft of climbing</small><span class="miles">11.4 mi</span></li>
  </ul>
</main>`

const FILES = {
  'package.json': JSON.stringify({ name: 'trailmap', version: '0.3.0', private: true, type: 'module', scripts: { start: 'node src/server.js', test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# trailmap\n\nA small service for saving and sharing hiking trails.\n',
  'src/server.js': `import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { addTrail, findTrails, removeTrail } from './store.js'

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html')
    return res.end(readFileSync('public/index.html'))
  }
  if (url.pathname === '/trails' && req.method === 'GET') {
    return res.end(JSON.stringify(findTrails(url.searchParams.get('q'))))
  }
  if (url.pathname === '/trails' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    return res.end(JSON.stringify(addTrail(JSON.parse(body))))
  }
  if (url.pathname.startsWith('/trails/') && req.method === 'DELETE') {
    removeTrail(url.pathname.split('/')[2])
    return res.end('ok')
  }
  res.statusCode = 404
  res.end('not found')
}).listen(3000)
`,
  'src/store.js': `import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'trails.json'
let trails = JSON.parse(readFileSync(FILE, 'utf8'))
let nextId = trails.length + 1

export function findTrails(q) {
  return q ? trails.filter((t) => t.name.includes(q)) : trails
}

export function addTrail(trail) {
  const saved = { id: nextId++, ...trail }
  trails.push(saved)
  writeFileSync(FILE, JSON.stringify(trails))
  return saved
}

export function removeTrail(id) {
  trails = trails.filter((t) => t.id != id)
  writeFileSync(FILE, JSON.stringify(trails))
}

export function distanceKm(trail) {
  return trail.miles * 1.6
}
`,
  'trails.json': JSON.stringify([{ id: 1, name: 'Ridgeback Loop', miles: 6.2, climb: 410 }, { id: 2, name: 'Fern Hollow', miles: 3.1, climb: 95 }, { id: 3, name: 'Eagle Saddle', miles: 11.4, climb: 1180 }]) + '\n',
  'public/index.html': `<!doctype html>
<title>trailmap</title>
<link rel="stylesheet" href="style.css">
<h1>Trails</h1>
<div class="search"><input id="q" placeholder="Search trails"><button>Search</button></div>
<ul id="list"></ul>
<script src="app.js"></script>
`,
  'public/style.css': STYLE,
  'public/app.js': `const list = document.getElementById('list')
fetch('/trails').then((r) => r.json()).then((trails) => {
  list.innerHTML = trails.map((t) => \`<li>\${t.name} <b>\${t.miles} mi</b></li>\`).join('')
})
`,
  'test/store.test.js': `import test from 'node:test'
import assert from 'node:assert'
import { distanceKm } from '../src/store.js'

test('converts miles', () => {
  assert.ok(distanceKm({ miles: 1 }) > 1.5)
})
`
}

export function writeDemoProject() {
  if (existsSync(DEMO_PATH)) rmSync(DEMO_PATH, { recursive: true, force: true })
  for (const [path, content] of Object.entries(FILES)) {
    const file = join(DEMO_PATH, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  const git = (...args) => execFileSync('git', args, { cwd: DEMO_PATH, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=Trailmap', '-c', 'user.email=dev@trailmap.example', 'commit', '-m', 'Trail list and search')
  return DEMO_PATH
}
