// Real CLI integration tests against a newly created loopback server only.
import { createSandbox, destroySandbox, p4, p4Env, login, stopServer } from './perforceSandbox.mjs'
import { spawnSync } from 'node:child_process'
import { writeFileSync, chmodSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers/promises'

function seed(s) {
const cwd = s.classic
const run = (args, input) => p4(s, ['-c', 'gloss-classic', ...args], { cwd, input })
run(['edit', 'src/main.c', 'src/rename-me.c', 'art/texture.bin'])
writeFileSync(join(cwd, 'src/main.c'), 'int main(void) {\n  return 1;\n}\n')
writeFileSync(join(cwd, 'art/texture.bin'), Buffer.from([0, 4, 5]))
run(['move', 'src/rename-me.c', 'src/renamed.c'])
run(['delete', 'src/delete-me.c'])
writeFileSync(join(cwd, 'src/added.c'), 'int added = 2;\n')
run(['add', 'src/added.c'])
chmodSync(join(cwd, 'src/crlf.txt'), 0o666)
writeFileSync(join(cwd, 'src/crlf.txt'), 'one\ntwo changed\nthree\n')
chmodSync(join(cwd, 'README.md'), 0o666)
unlinkSync(join(cwd, 'README.md'))
writeFileSync(join(cwd, '.p4ignore'), '*.tmp\ncrlf.txt\ngenerated/\n')
writeFileSync(join(cwd, 'src/ignored.tmp'), 'ignored')
writeFileSync(join(cwd, 'src/café.tmp'), 'ignored non-ASCII file')
writeFileSync(join(cwd, 'src/new.c'), 'unopened')
mkdirSync(join(cwd, 'generated'))
writeFileSync(join(cwd, 'generated/ignored.c'), 'ignored')
const result = run(['change', '-i'], 'Change: new\nClient: gloss-classic\nUser: gloss\nDescription:\n\tIntegration fixture\n')
const change = /Change (\d+) created/.exec(result)?.[1]
run(['reopen', '-c', change, 'src/main.c'])

const nonAscii = readdirSync(join(cwd, 'src')).find((name) => name.startsWith('na'))
run(['edit', 'src/' + nonAscii])
writeFileSync(join(cwd, 'src', nonAscii), 'changed non-ASCII file\n')
spawnSync('git', ['init', '--quiet'], { cwd, windowsHide: true })
}

const s = await createSandbox({ files: 10, unicode: process.argv.includes('--unicode') })
function test(error) {
  const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'src/main/perforce.test.ts'], {
    windowsHide: true, stdio: 'inherit',
    env: p4Env(s, { P4CONFIG: '.p4config', P4IGNORE: '.p4ignore', GLOSS_P4_TEST_WORKSPACE: s.classic, GLOSS_P4_TEST_SEEDED: '1', GLOSS_P4_TEST_STREAM: s.stream, GLOSS_P4_EXPECT_ERROR: error })
  })
  if (result.status !== 0) throw new Error('Perforce integration tests failed')
}
try {
  seed(s)
  test()
  p4(s, ['logout'])
  test('login')
  login(s)
  p4(s, ['group', '-i'], { input: 'Group: short\nTimeout: 3\nUsers:\n\tgloss\n' })
  login(s)
  await setTimeout(4500)
  test('expired')
  stopServer(s)
  test('unavailable')
} finally { destroySandbox(s.dir) }
