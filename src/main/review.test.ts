import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBranch, parseDiff, readReviewDiff } from './review'

describe('parseDiff', () => {
  it('reads files, hunks and line numbers', () => {
    const out = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@ export class A {',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' ',
      ' four',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 90%',
      'rename from old name.ts',
      'rename to new name.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      ''
    ].join('\n')
    const files = parseDiff(out)
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ['src/a.ts', 'modified', 2, 1, false],
      ['new.txt', 'added', 1, 0, false],
      ['gone.ts', 'deleted', 0, 2, false],
      ['new name.ts', 'renamed', 0, 0, false],
      ['logo.png', 'modified', 0, 0, true]
    ])
    expect(files[0].hunks[0].lines).toEqual([
      { kind: 'context', old: 10, new: 10, text: 'one' },
      { kind: 'del', old: 11, new: null, text: 'two' },
      { kind: 'add', old: null, new: 11, text: 'TWO' },
      { kind: 'add', old: null, new: 12, text: 'three' },
      { kind: 'context', old: 12, new: 13, text: '' },
      { kind: 'context', old: 13, new: 14, text: 'four' }
    ])
    expect(files[3].oldPath).toBe('old name.ts')
  })

  it('takes a line that looks like a header as code inside a hunk', () => {
    const files = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '---- not a header', '++++ nor this', ''].join('\n'))
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual(['--- not a header', '+++ nor this'])
  })
})

describe('readReviewDiff', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })

  it('shows the branch since main, committed or not, and new files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-review-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n')
    writeFileSync(join(dir, 'b.ts'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'a.ts'), 'one\nTWO\n')
    git('commit', '-q', '-am', 'change a')
    writeFileSync(join(dir, 'a.ts'), 'one\nTWO\nthree\n')
    writeFileSync(join(dir, 'b.ts'), 'B\n')
    writeFileSync(join(dir, 'c.ts'), 'new\nfile\n')

    expect(await defaultBranch(dir)).toBe('main')
    const diff = await readReviewDiff(dir, 'main')
    expect(diff.base).toBe(git('rev-parse', 'main').trim())
    expect(diff.files.map((f) => [f.path, f.state, f.additions, f.deletions])).toEqual([
      ['a.ts', 'both', 2, 1],
      ['b.ts', 'uncommitted', 1, 1],
      ['c.ts', 'uncommitted', 2, 0]
    ])
    expect(diff.files[2].hunks[0].lines.map((l) => [l.new, l.text])).toEqual([
      [1, 'new'],
      [2, 'file']
    ])
  })

  it('shows uncommitted changes on the default branch itself', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-review-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.ts'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    writeFileSync(join(dir, 'a.ts'), 'uno\n')
    const diff = await readReviewDiff(dir, 'main')
    expect(diff.files.map((f) => [f.path, f.state])).toEqual([['a.ts', 'uncommitted']])
  })
})
