// M23 Perforce sandbox: a throwaway p4d with a classic and a stream workspace, built
// fresh each run under the temp folder. Nothing here touches the user's own Perforce
// settings: every command gets its port, user, client and ticket file explicitly.
// Used by npm run test:perforce. All fixture data is generated in the temp folder.
// P4_BIN and P4D_BIN override the p4 and p4d executables.
import { execFileSync, spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'

const windows = process.platform === 'win32'
export const P4 = process.env.P4_BIN ?? 'p4'
export const P4D = process.env.P4D_BIN ?? (windows && existsSync('C:\\Program Files\\Perforce\\Server\\p4d.exe') ? 'C:\\Program Files\\Perforce\\Server\\p4d.exe' : 'p4d')
export const USER = 'gloss'
export const PASSWORD = 'Sandbox-pass1'

/** The environment for p4 in the sandbox: explicit settings, no P4CONFIG unless asked for. */
export function p4Env(sandbox, extra = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('P4')))
  const env = { ...inherited, P4CONFIG: '.gloss-no-config', P4CHARSET: sandbox.unicode ? 'utf8' : undefined, P4PORT: sandbox.port, P4USER: USER, P4TICKETS: join(sandbox.dir, 'tickets.txt'), P4ENVIRO: join(sandbox.dir, 'enviro.txt'), ...extra }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
  return env
}

/** Runs p4; returns stdout, or throws with stderr. p4 takes its directory from PWD when set, so PWD is the cwd. */
export function p4(sandbox, args, { cwd = sandbox.dir, input, env = {} } = {}) {
  if (sandbox.unicode && args.some((arg) => Array.from(arg).some((c) => c.charCodeAt(0) > 127))) {
    const paths = args.filter((arg) => Array.from(arg).some((c) => c.charCodeAt(0) > 127))
    const file = join(sandbox.dir, 'unicode-args')
    writeFileSync(file, paths.join('\n') + '\n')
    args = ['-x', file, ...args.filter((arg) => !paths.includes(arg))]
  }
  return execFileSync(P4, args, { cwd, input, env: p4Env(sandbox, { PWD: cwd, ...env }), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    }).on('error', reject)
  })
}

async function waitForServer(sandbox) {
  for (let i = 0; i < 50; i++) {
    try { p4(sandbox, ['-ztag', 'info']); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error('p4d did not start')
}

/** Starts p4d on a sandbox's existing root (also used to restart it after a stop). */
export async function startServer(sandbox) {
  const child = spawn(P4D, ['-r', join(sandbox.dir, 'root'), '-p', sandbox.port, '-L', 'log', '-J', 'journal'], { env: p4Env(sandbox), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  sandbox.pid = child.pid
  writeFileSync(join(sandbox.dir, 'sandbox.json'), JSON.stringify(sandbox, null, 2))
  await waitForServer(sandbox)
}

export function login(sandbox) {
  p4(sandbox, ['login'], { input: `${PASSWORD}\n` })
}

export function stopServer(sandbox) {
  try { process.kill(sandbox.pid) } catch { /* already gone */ }
}

export function loadSandbox(dir) {
  return JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8'))
}

const spec = (fields) => Object.entries(fields).map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map((l) => `\t${l}`).join('\n')}\n` : `${k}:\t${v}\n`).join('\n')

export async function createSandbox({ files = 0, unicode = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-p4-sandbox-'))
  mkdirSync(join(dir, 'root'))
  const sandbox = { dir, port: `localhost:${await freePort()}`, pid: 0, unicode }
  if (unicode) execFileSync(P4D, ['-r', join(dir, 'root'), '-xi'], { windowsHide: true, stdio: 'pipe' })
  await startServer(sandbox)
  // A new 2026.1 server has security on: the first `p4 passwd` creates the user (as super), then log in.
  p4(sandbox, ['passwd'], { input: `${PASSWORD}\n${PASSWORD}\n` })
  login(sandbox)

  // A stream depot with a mainline; the default classic depot //depot exists already.
  p4(sandbox, ['depot', '-i'], { input: spec({ Depot: 'streams', Type: 'stream', StreamDepth: '//streams/1', Map: 'streams/...' }) })
  p4(sandbox, ['stream', '-i'], { input: spec({ Stream: '//streams/main', Owner: USER, Name: 'main', Parent: 'none', Type: 'mainline', ParentView: 'inherit', Paths: ['share ...'] }) })

  // Classic workspace: //depot/... except //depot/unmapped/..., in <dir>/classic.
  const classic = join(dir, 'classic')
  const stream = join(dir, 'stream')
  mkdirSync(classic)
  mkdirSync(stream)
  p4(sandbox, ['client', '-i'], { input: spec({ Client: 'gloss-classic', Owner: USER, Root: classic, Options: 'noallwrite noclobber nocompress unlocked nomodtime normdir', LineEnd: 'local', View: ['//depot/... //gloss-classic/...', '-//depot/unmapped/... //gloss-classic/unmapped/...'] }) })
  p4(sandbox, ['client', '-i'], { input: spec({ Client: 'gloss-stream', Owner: USER, Root: stream, Stream: '//streams/main', Options: 'noallwrite noclobber nocompress unlocked nomodtime normdir', LineEnd: 'local' }) })
  for (const [root, client] of [[classic, 'gloss-classic'], [stream, 'gloss-stream']]) {
    writeFileSync(join(root, '.p4config'), `P4PORT=${sandbox.port}\nP4USER=${USER}\nP4CLIENT=${client}\nP4TICKETS=${join(dir, 'tickets.txt')}\n${unicode ? 'P4CHARSET=utf8\n' : ''}`)
  }

  // Content: text, CRLF text, binary, a non-ASCII name, nested folders, and N filler files.
  for (const root of [classic, stream]) {
    mkdirSync(join(root, 'src', 'game'), { recursive: true })
    mkdirSync(join(root, 'art'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# Sandbox\n\nA Gloss Perforce sandbox.\n')
    writeFileSync(join(root, 'src', 'main.c'), 'int main(void) {\n  return 0;\n}\n')
    writeFileSync(join(root, 'src', 'game', 'player.c'), Array.from({ length: 40 }, (_, i) => `int stat_${i} = ${i};`).join('\n') + '\n')
    writeFileSync(join(root, 'src', 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
    writeFileSync(join(root, 'src', 'rename-me.c'), 'void old_name(void) {}\n')
    writeFileSync(join(root, 'src', 'delete-me.c'), 'void unused(void) {}\n')
    writeFileSync(join(root, 'src', 'naïve café.txt'), 'unicode name\n')
    writeFileSync(join(root, 'art', 'texture.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 128, 64]))
    for (let i = 0; i < files; i++) {
      const sub = join(root, 'filler', String(Math.floor(i / 500)))
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, `f${i}.txt`), `filler ${i}\n`)
    }
  }
  // Present on disk but outside the classic view.
  mkdirSync(join(classic, 'unmapped'))
  writeFileSync(join(classic, 'unmapped', 'note.txt'), 'not in the client view\n')

  for (const [root, client] of [[classic, 'gloss-classic'], [stream, 'gloss-stream']]) {
    p4(sandbox, ['-c', client, 'add', '-f', '...'], { cwd: root })
    p4(sandbox, ['-c', client, 'revert', '-k', '.p4config'], { cwd: root })
    try { p4(sandbox, ['-c', client, 'revert', '-k', 'unmapped/...'], { cwd: root }) } catch { /* not opened */ }
    p4(sandbox, ['-c', client, 'submit', '-d', 'Initial content'], { cwd: root })
  }

  // A folder outside every client's root.
  mkdirSync(join(dir, 'elsewhere'))
  writeFileSync(join(sandbox.dir, 'sandbox.json'), JSON.stringify({ ...sandbox, classic, stream }, null, 2))
  return { ...sandbox, classic, stream }
}

export function destroySandbox(dir) {
  const target = resolve(dir)
  if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('gloss-p4-sandbox-')) throw new Error('Refusing to remove a path outside the test sandbox')
  stopServer(loadSandbox(dir))
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500) }
  }
}
