import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktree, hasUnfinishedWork, listWorktrees, parseWorktreeList, removeWorktree, unfinishedWork
} from './worktrees'

// These tests exercise local Git repositories, without invoking gh or its authentication/network.
vi.mock('./git', () => ({ pullRequest: vi.fn(async () => null) }))

let root: string
let repo: string
let remote: string
let home: string
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function windowsShortPath(path: string): string {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("%GLOSS_TEST_WORKTREE%") do @echo %~sI'], {
    encoding: 'utf8', env: { ...process.env, GLOSS_TEST_WORKTREE: path }, windowsHide: true, windowsVerbatimArguments: true
  })
  expect(result.status).toBe(0)
  const shortPath = result.stdout.trim()
  expect(existsSync(shortPath)).toBe(true)
  return shortPath
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gloss-worktrees-test-'))
  repo = join(root, 'project')
  remote = join(root, 'remote.git')
  home = join(root, 'worktrees')
  mkdirSync(repo)
  git(root, 'init', '-q', '--bare', remote)
  git(repo, 'init', '-q', '-b', 'dev')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'dev')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('parseWorktreeList', () => {
  it('reads branches and detached heads, and skips folders that are gone', () => {
    const out = [
      'worktree C:/p/project', 'HEAD aaa', 'branch refs/heads/dev', '',
      'worktree C:/w/project/k3f9', 'HEAD bbb', 'detached', '',
      'worktree C:/w/project/gone', 'HEAD ccc', 'branch refs/heads/gloss/gone', 'prunable gitdir file points to non-existent location', ''
    ].join('\r\n')
    const entries = parseWorktreeList(out)
    expect(entries.map((e) => [e.branch, e.head, e.main])).toEqual([['dev', 'aaa', true], [null, 'bbb', false]])
  })
})

// Each test launches real Git processes, which take longer on Windows CI.
describe('worktrees', { timeout: 30_000 }, () => {
  it('creates one on a new branch from the project folder\'s branch, outside the repository', async () => {
    const created = await createWorktree(repo, home, undefined)
    expect(created.branch).toMatch(/^gloss\/[a-z0-9]{4}$/)
    expect(created.path).toBe(join(home, 'project', created.branch.slice('gloss/'.length)))
    expect(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(created.branch)
    const listed = await listWorktrees(repo)
    expect(listed.map((e) => [e.branch, e.main])).toEqual([['dev', true], [created.branch, false]])
  })

  it('fetches a remote base branch first', async () => {
    const other = join(root, 'other')
    git(root, 'clone', '-q', '-b', 'dev', remote, other)
    git(other, 'config', 'user.email', 'test@example.com')
    git(other, 'config', 'user.name', 'Test')
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'upstream')
    git(other, 'push', '-q', 'origin', 'dev')
    const created = await createWorktree(repo, home, 'origin/dev')
    expect(existsSync(join(created.path, 'b.txt'))).toBe(true)
  })

  it('rejects a base that doesn\'t exist', async () => {
    await expect(createWorktree(repo, home, 'nope')).rejects.toThrow()
  })

  it('counts uncommitted changes and unpushed commits, not ignored files', async () => {
    const { path, branch } = await createWorktree(repo, home, undefined)
    mkdirSync(join(path, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(path, 'node_modules', 'x', 'index.js'), '//\n')
    expect(await unfinishedWork(path, branch)).toMatchObject({ uncommitted: 0, unpushed: 0 })
    writeFileSync(join(path, 'new.txt'), 'new\n')
    expect(await unfinishedWork(path, branch)).toMatchObject({ uncommitted: 1, unpushed: 0 })
    git(path, 'add', 'new.txt')
    git(path, 'commit', '-q', '-m', 'work')
    expect(await unfinishedWork(path, branch)).toMatchObject({ uncommitted: 0, unpushed: 1 })
    git(path, 'push', '-q', '-u', 'origin', branch)
    expect(await unfinishedWork(path, branch)).toMatchObject({ unpushed: 0 })
    // A squash merge deletes the remote branch: the commits look unpushed again.
    git(repo, 'push', '-q', 'origin', '--delete', branch)
    git(repo, 'fetch', '-q', '--prune')
    expect(await unfinishedWork(path, branch)).toMatchObject({ unpushed: 1 })
  })

  it('counts commits on no other branch, so a repository without a remote works and a local merge keeps them', async () => {
    git(repo, 'remote', 'remove', 'origin')
    const { path, branch } = await createWorktree(repo, home, undefined)
    expect(await unfinishedWork(path, branch)).toMatchObject({ unpushed: 0 })
    writeFileSync(join(path, 'b.txt'), 'b\n')
    git(path, 'add', 'b.txt')
    git(path, 'commit', '-q', '-m', 'work')
    expect(await unfinishedWork(path, branch)).toMatchObject({ unpushed: 1 })
    git(repo, 'merge', '-q', '--ff-only', branch)
    expect(await unfinishedWork(path, branch)).toMatchObject({ unpushed: 0 })
  })

  it('removes a worktree with deep ignored paths and untracked files, and its branch', async () => {
    const { path, branch } = await createWorktree(repo, home, undefined)
    const deep = join(path, 'node_modules', ...Array<string>(30).fill('deep-package-name'))
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'index.js'), '//\n')
    writeFileSync(join(path, 'untracked.txt'), 'x\n')
    await removeWorktree(repo, path, branch)
    expect(existsSync(path)).toBe(false)
    expect((await listWorktrees(repo)).length).toBe(1)
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).toThrow()
  })

  it('never deletes the project folder or a folder that isn\'t one of its worktrees', async () => {
    const stray = join(root, 'stray')
    mkdirSync(stray)
    await expect(removeWorktree(repo, stray, null)).rejects.toThrow()
    await expect(removeWorktree(repo, repo, null)).rejects.toThrow()
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('removes a worktree addressed by its Windows short path', async () => {
    const { path, branch } = await createWorktree(repo, home, undefined)
    const shortPath = windowsShortPath(path)
    await removeWorktree(repo, shortPath, branch)
    expect(existsSync(path)).toBe(false)
    expect((await listWorktrees(repo)).length).toBe(1)
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).toThrow()
    const shortRepo = windowsShortPath(repo)
    await expect(removeWorktree(repo, shortRepo, null)).rejects.toThrow()
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })
})

describe('hasUnfinishedWork', () => {
  const pr = (state: 'open' | 'draft' | 'merged') => ({ number: 1, title: '', url: 'https://x', state, checks: null, review: null, baseRef: 'dev' })
  it('follows the rules', () => {
    expect(hasUnfinishedWork({ uncommitted: 0, unpushed: 0, pr: null })).toBe(false)
    expect(hasUnfinishedWork({ uncommitted: 1, unpushed: 0, pr: null })).toBe(true)
    expect(hasUnfinishedWork({ uncommitted: 0, unpushed: 2, pr: null })).toBe(true)
    expect(hasUnfinishedWork({ uncommitted: 0, unpushed: 0, pr: pr('open') })).toBe(true)
    expect(hasUnfinishedWork({ uncommitted: 0, unpushed: 0, pr: pr('draft') })).toBe(true)
    // Merged at the branch's commit: its commits are kept even when the remote branch is gone.
    expect(hasUnfinishedWork({ uncommitted: 0, unpushed: 2, pr: pr('merged') })).toBe(false)
    expect(hasUnfinishedWork({ uncommitted: 1, unpushed: 0, pr: pr('merged') })).toBe(true)
  })
})
