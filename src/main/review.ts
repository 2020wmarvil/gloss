// The diff a review session shows (SPEC → Review sessions): from a base commit (or the
// merge base with a branch) to a commit or the working tree, read with git.
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { isCommitId, type DiffFile, type DiffHunk, type DiffLine, type ReviewCommit, type ReviewDiff } from '../shared/review'

/** Untracked files larger than this show as a header only, and lines around a diff can't be shown from them. */
const MAX_FILE_BYTES = 1024 * 1024

/** Runs git in `cwd`; resolves its stdout, or rejects with git's message. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      // A fetch must fail rather than wait for a password.
      { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim().split('\n')[0] || err.message))
        else resolve(stdout)
      }
    )
  })
}

function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null)
}

/**
 * The default branch: origin/HEAD's branch, else main, master, origin/main or origin/master
 * (a clone without origin/HEAD may have no local main). Null if none.
 */
export async function defaultBranch(cwd: string): Promise<string | null> {
  const remote = await gitOrNull(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remote?.trim()) return remote.trim()
  for (const [ref, name] of [
    ['refs/heads/main', 'main'],
    ['refs/heads/master', 'master'],
    ['refs/remotes/origin/main', 'origin/main'],
    ['refs/remotes/origin/master', 'origin/master']
  ]) {
    if ((await gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', ref])) !== null) return name
  }
  return null
}

/**
 * What a pull request into `branch` is reviewed against: `origin/<branch>`, fetched
 * first (unless `fetch` is false) so it matches GitHub, else the local branch. Null if
 * neither exists.
 */
export async function pullRequestBase(cwd: string, branch: string, fetch = true): Promise<string | null> {
  if (fetch) await gitOrNull(cwd, ['fetch', '--quiet', 'origin', branch])
  for (const [ref, name] of [
    [`refs/remotes/origin/${branch}`, `origin/${branch}`],
    [`refs/heads/${branch}`, branch]
  ]) {
    if ((await gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', ref])) !== null) return name
  }
  return null
}

/** The branch checked out in `cwd` ("detached HEAD" without one); null outside a repository. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const name = await gitOrNull(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (name === null) return null
  return name.trim() === 'HEAD' ? 'detached HEAD' : name.trim()
}

/** The commit a ref names, or null. */
async function commitOf(cwd: string, ref: string): Promise<string | null> {
  return (await gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() || null
}

/**
 * The diff under review, from `baseRef` (a commit, or a branch whose merge base is used)
 * to `headRef` (a commit), or to the working tree without one: tracked changes plus
 * untracked files as new ones.
 */
export async function readReviewDiff(cwd: string, baseRef: string, headRef: string | null = null): Promise<ReviewDiff> {
  const head = await commitOf(cwd, headRef ?? 'HEAD')
  if (!head) throw new Error(headRef ? `No commit ${headRef}.` : 'This repository has no commits yet.')
  const base = isCommitId(baseRef) ? await commitOf(cwd, baseRef) : (await git(cwd, ['merge-base', head, baseRef])).trim()
  if (!base) throw new Error(`No commit ${baseRef}.`)
  if (headRef !== null) {
    const files = parseDiff(await git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, head, '--']))
    for (const f of files) f.state = 'committed'
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { baseRef, base, headRef, head, files }
  }
  const [diff, committed, uncommitted, untracked, root] = await Promise.all([
    git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, '--']),
    git(cwd, ['diff', '--name-only', '-z', '-M', base, 'HEAD', '--']),
    git(cwd, ['diff', '--name-only', '-z', '-M', 'HEAD', '--']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', ':/']),
    git(cwd, ['rev-parse', '--show-toplevel'])
  ])
  const inCommits = new Set(committed.split('\0').filter(Boolean))
  const inTree = new Set(uncommitted.split('\0').filter(Boolean))
  const files = parseDiff(diff)
  for (const path of untracked.split('\0').filter(Boolean)) {
    inTree.add(path)
    files.push(await untrackedFile(join(root.trim(), path), path))
  }
  for (const f of files) {
    const c = inCommits.has(f.path) || (f.oldPath !== undefined && inCommits.has(f.oldPath))
    const u = inTree.has(f.path) || (f.oldPath !== undefined && inTree.has(f.oldPath))
    f.state = c && u ? 'both' : c ? 'committed' : 'uncommitted'
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { baseRef, base, headRef, head, files }
}

/**
 * The branch's recent commits for the review's dropdowns, newest first (first parents):
 * those since `since` (a merge base) and 20 more, at most 50.
 */
export async function reviewCommits(cwd: string, since: string | null): Promise<ReviewCommit[]> {
  let count = 50
  if (since) {
    const ahead = Number((await gitOrNull(cwd, ['rev-list', '--count', '--first-parent', `${since}..HEAD`]))?.trim())
    if (Number.isFinite(ahead)) count = Math.min(50, ahead + 20)
  }
  const out = await gitOrNull(cwd, ['log', '--first-parent', `-n${count}`, '--format=%H%x00%s%x00%ct', 'HEAD', '--'])
  return (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, time] = line.split('\0')
      return { sha, subject, at: Number(time) * 1000 }
    })
}

/** The merge base of HEAD and a branch, or null. */
export async function mergeBase(cwd: string, ref: string): Promise<string | null> {
  return (await gitOrNull(cwd, ['merge-base', 'HEAD', ref]))?.trim() || null
}

/** A text file's lines; null if it can't be read, is binary or is too large. */
async function readLines(absolute: string): Promise<string[] | null> {
  try {
    const handle = await open(absolute, 'r')
    try {
      const { size } = await handle.stat()
      if (size > MAX_FILE_BYTES) return null
      const buf = await handle.readFile()
      if (buf.subarray(0, 8000).includes(0)) return null
      const lines = buf.toString('utf8').split(/\r?\n/)
      if (lines[lines.length - 1] === '') lines.pop()
      return lines
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * A file of the diff on its new side, for showing the lines around its hunks: at
 * `headRef`, or in the working tree without one. `path` is relative to the repository
 * root. Null if the file is missing, binary, too large or outside the repository.
 */
export async function readReviewFile(cwd: string, path: string, headRef: string | null = null): Promise<string[] | null> {
  if (headRef !== null) {
    const text = await gitOrNull(cwd, ['show', `${headRef}:${path}`])
    if (text === null || text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return null
    const lines = text.split(/\r?\n/)
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const absolute = join(root, path)
  const inside = relative(root, absolute)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  return readLines(absolute)
}

/** A file of the repository in the working tree, by its path from the root. Rejects one outside it or missing. */
export async function workingFilePath(cwd: string, path: string): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const absolute = join(root, path)
  const inside = relative(root, absolute)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${path} is outside the repository.`)
  try {
    await (await open(absolute, 'r')).close()
  } catch {
    throw new Error(`${path} isn't in the working tree.`)
  }
  return absolute
}

/** A new file git doesn't track yet, as a diff that adds every line. */
async function untrackedFile(absolute: string, path: string): Promise<DiffFile> {
  const file: DiffFile = { path, status: 'added', binary: false, state: 'uncommitted', additions: 0, deletions: 0, hunks: [] }
  const lines = await readLines(absolute)
  if (lines === null) return { ...file, binary: true }
  if (lines.length === 0) return file
  file.additions = lines.length
  file.hunks = [
    {
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((t, i): DiffLine => ({ kind: 'add', old: null, new: i + 1, text: t }))
    }
  ]
  return file
}

/** A path in a diff header: `a/x` or `b/x`, possibly C-quoted. Null for /dev/null. */
function headerPath(raw: string): string | null {
  let p = raw.replace(/\t$/, '')
  if (p === '/dev/null') return null
  if (p.startsWith('"') && p.endsWith('"')) p = unquote(p.slice(1, -1))
  return p.replace(/^[ab]\//, '')
}

/** Undoes git's C-style quoting (octal escapes are UTF-8 bytes). */
function unquote(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = s[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92 } as Record<string, number>)[next] ?? next.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Parses `git diff` output into files and hunks. `state` is filled in by the caller. */
export function parseDiff(output: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldN = 0
  let newN = 0
  /** Lines of the current hunk still to come, per side. */
  let oldLeft = 0
  let newLeft = 0
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const text = line.slice(1)
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', old: null, new: newN++, text })
        file.additions++
        newLeft--
        continue
      }
      if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', old: oldN++, new: null, text })
        file.deletions++
        oldLeft--
        continue
      }
      if (line.startsWith(' ') || line === '') {
        hunk.lines.push({ kind: 'context', old: oldN++, new: newN++, text })
        oldLeft--
        newLeft--
        continue
      }
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('diff --git ')) {
      file = { path: gitLinePath(line), status: 'modified', binary: false, state: 'uncommitted', additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) {
      oldN = Number(h[1])
      oldLeft = h[2] === undefined ? 1 : Number(h[2])
      newN = Number(h[3])
      newLeft = h[4] === undefined ? 1 : Number(h[4])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (file.hunks.length > 0) continue
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
    else if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4))
      if (p !== null) file.path = p
    }
  }
  return files
}

/** The new path from a `diff --git a/x b/y` line; the ---/+++ lines, when present, replace it. */
function gitLinePath(line: string): string {
  const rest = line.slice('diff --git '.length)
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (quoted) return unquote(quoted[1])
  const half = rest.length / 2
  // Unquoted, both halves are "a/<path>" and "b/<path>" when the path didn't change.
  if (Number.isInteger(half - 0.5) && rest.slice(0, half - 0.5).slice(2) === rest.slice(half + 0.5).slice(2)) {
    return rest.slice(half + 0.5).slice(2)
  }
  const i = rest.lastIndexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : rest
}
