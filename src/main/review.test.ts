import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultBranch, parseDiff, pullRequestBase, readReviewDiff, readReviewFile, reviewCommits } from './review'

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

    // Without an origin it falls back to the local branch.
    expect(await pullRequestBase(dir, 'main')).toBe('main')
    expect(await pullRequestBase(dir, 'nope')).toBeNull()
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

  it('reads a file as it is now from the repository root, and nothing outside it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-review-'))
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a.ts'), 'one\r\ntwo\r\n')
    writeFileSync(join(dir, 'bin'), Buffer.from([1, 0, 2]))
    expect(await readReviewFile(join(dir, 'sub'), 'sub/a.ts')).toEqual(['one', 'two'])
    expect(await readReviewFile(dir, 'bin')).toBeNull()
    expect(await readReviewFile(dir, 'missing.ts')).toBeNull()
    expect(await readReviewFile(join(dir, 'sub'), '../outside.ts')).toBeNull()
  })

  it('compares two commits, and lists the branch commits', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-review-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.ts'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'a.ts'), 'two\n')
    git('commit', '-q', '-am', 'second')
    const second = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(dir, 'a.ts'), 'three\n')
    git('commit', '-q', '-am', 'third')
    writeFileSync(join(dir, 'a.ts'), 'four\n')
    writeFileSync(join(dir, 'new.ts'), 'new\n')

    expect(await defaultBranch(dir)).toBe('main')
    // Without origin/HEAD, the remote's main comes before a local main, which may be stale.
    git('update-ref', 'refs/remotes/origin/main', 'main')
    expect(await defaultBranch(dir)).toBe('origin/main')
    // origin/HEAD names it.
    git('update-ref', 'refs/remotes/origin/trunk', 'main')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    expect(await defaultBranch(dir)).toBe('origin/trunk')
    const diff = await readReviewDiff(dir, 'main', second)
    expect(diff).toMatchObject({ headRef: second, head: second, base: git('rev-parse', 'main').trim() })
    expect(diff.files.map((f) => [f.path, f.state, f.hunks[0].lines.map((l) => l.text)])).toEqual([['a.ts', 'committed', ['one', 'two']]])
    // A commit as the base is used as is.
    const fromSecond = await readReviewDiff(dir, second, 'HEAD')
    expect(fromSecond.base).toBe(second)
    expect(fromSecond.files[0].hunks[0].lines.map((l) => l.text)).toEqual(['two', 'three'])
    await expect(readReviewDiff(dir, 'main', 'nope')).rejects.toThrow('No commit nope')

    expect(await readReviewFile(dir, 'a.ts', second)).toEqual(['two'])
    expect(await readReviewFile(dir, 'a.ts')).toEqual(['four'])
    expect(await readReviewFile(dir, 'new.ts', 'HEAD')).toBeNull()

    const commits = await reviewCommits(dir, git('rev-parse', 'main').trim())
    expect(commits.map((c) => c.subject)).toEqual(['third', 'second', 'base'])
    expect(commits[1].sha).toBe(second)
  })

  it('shows only uncommitted changes and new files against HEAD', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-review-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.ts'), 'one\n')
    writeFileSync(join(dir, 'b.ts'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'a.ts'), 'uno\n')
    git('commit', '-q', '-am', 'committed')
    writeFileSync(join(dir, 'b.ts'), 'B\n')
    git('add', 'b.ts')
    writeFileSync(join(dir, 'c.ts'), 'c\n')
    const diff = await readReviewDiff(dir, 'HEAD')
    expect(diff.base).toBe(git('rev-parse', 'HEAD').trim())
    expect(diff.files.map((f) => [f.path, f.state])).toEqual([
      ['b.ts', 'uncommitted'],
      ['c.ts', 'uncommitted']
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
