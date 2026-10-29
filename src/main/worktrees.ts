// A project's git worktrees (SPEC → Worktrees): listing, creating, what work is left in one, and removing.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pullRequest } from './git'
import type { PullRequest } from '../shared/ipc'
import { sameFolder } from '../shared/paths'

export type WorktreeEntry = {
  path: string
  /** Null on a detached HEAD. */
  branch: string | null
  head: string | null
  /** The project's own checkout: the first entry of `git worktree list`. */
  main: boolean
}

export type UnfinishedWork = {
  /** Lines of `git status --porcelain`: changed tracked files and new files git doesn't ignore. */
  uncommitted: number
  /** Commits only on this branch: on no other branch, local or remote. */
  unpushed: number
  /** The branch's PR, if `gh` finds an open or draft one, or one merged at the branch's commit. */
  pr: PullRequest | null
}

/** Runs git in `cwd`; resolves stdout, rejects with git's message. Long paths, for deep `node_modules` on Windows. */
function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().replace(/^fatal: /, '')))
      else resolvePromise(stdout)
    })
  })
}

/** Parses `git worktree list --porcelain`, dropping entries whose folder is gone (`prunable`). */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of output.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path || lines.some((l) => l.startsWith('prunable')) || lines.includes('bare')) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length)
    entries.push({
      path: resolve(path),
      branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null,
      main: entries.length === 0
    })
  }
  return entries
}

/** The project folder's worktrees, itself first; empty outside a repository. */
export async function listWorktrees(projectPath: string): Promise<WorktreeEntry[]> {
  try {
    return parseWorktreeList(await git(projectPath, ['worktree', 'list', '--porcelain'], 10_000))
  } catch {
    return []
  }
}

export function countLines(output: string): number {
  return output.split('\n').filter((l) => l.trim() !== '').length
}

/** What a worktree holds that isn't anywhere else (SPEC → Worktrees → Unfinished work). */
export async function unfinishedWork(path: string, branch: string | null): Promise<UnfinishedWork> {
  const [status, unpushed, pr] = await Promise.all([
    git(path, ['status', '--porcelain'], 15_000),
    // Only on this branch: on no other branch, local or remote (so a repository without a remote works too).
    branch ? git(path, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes'], 15_000) : Promise.resolve('0'),
    branch ? pullRequest(path).catch(() => null) : Promise.resolve(null)
  ])
  const relevant = pr && (pr.state === 'open' || pr.state === 'draft' || pr.state === 'merged') ? pr : null
  return { uncommitted: countLines(status), unpushed: Number.parseInt(unpushed.trim(), 10) || 0, pr: relevant }
}

/** Whether anything would be lost by removing it. A PR merged at the branch's commit means its commits are kept. */
export function hasUnfinishedWork(work: UnfinishedWork): boolean {
  if (work.uncommitted > 0) return true
  if (work.pr?.state === 'open' || work.pr?.state === 'draft') return true
  return work.unpushed > 0 && work.pr?.state !== 'merged'
}

const ADJECTIVES = [
  'amber', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', 'curious', 'daring', 'dusty', 'eager',
  'fancy', 'fluffy', 'gentle', 'gleaming', 'golden', 'happy', 'hidden', 'humble', 'jolly', 'keen', 'lively', 'lucky',
  'mellow', 'merry', 'misty', 'nimble', 'noble', 'patient', 'plucky', 'polished', 'proud', 'quiet', 'quick', 'rapid',
  'rustic', 'sandy', 'shiny', 'silent', 'silver', 'sleepy', 'smooth', 'snowy', 'sunny', 'swift', 'tidy', 'tiny',
  'velvet', 'vivid', 'wandering', 'warm', 'wild', 'windy', 'wise', 'witty', 'zesty', 'breezy', 'cheerful', 'cozy',
  'dapper', 'fearless', 'frosty', 'radiant'
]
const NOUNS = [
  'acorn', 'badger', 'beacon', 'birch', 'bison', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'creek', 'dolphin',
  'dune', 'ember', 'falcon', 'fern', 'finch', 'fjord', 'fox', 'glacier', 'harbor', 'hedgehog', 'heron', 'island',
  'jaguar', 'kestrel', 'koala', 'lagoon', 'lantern', 'lark', 'lemur', 'lynx', 'maple', 'meadow', 'meteor', 'moose',
  'nebula', 'otter', 'owl', 'panda', 'pebble', 'pine', 'planet', 'puffin', 'quartz', 'raven', 'reef', 'river',
  'robin', 'sparrow', 'spruce', 'squirrel', 'summit', 'tiger', 'tundra', 'turtle', 'valley', 'walrus', 'willow',
  'wombat', 'wren', 'yak', 'zebra', 'orchid'
]

/** A generated name: an adjective and a noun, like `swift-otter`. */
export function worktreeName(): string {
  const [a, b] = randomBytes(2)
  return `${ADJECTIVES[a % ADJECTIVES.length]}-${NOUNS[b % NOUNS.length]}`
}

/**
 * The branch a new worktree starts from: the `base` setting, or the project folder's
 * current branch (its commit when detached). A remote branch is fetched first.
 */
export async function resolveBase(projectPath: string, base: string | undefined): Promise<string> {
  const named = base?.trim()
  if (!named) {
    const branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return branch === 'HEAD' ? (await git(projectPath, ['rev-parse', 'HEAD'])).trim() : branch
  }
  const remotes = (await git(projectPath, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean)
  const remote = remotes.find((r) => named.startsWith(`${r}/`))
  if (remote) await git(projectPath, ['fetch', remote, named.slice(remote.length + 1)], 120_000)
  await git(projectPath, ['rev-parse', '--verify', '--quiet', `${named}^{commit}`])
  return named
}

/**
 * Creates a worktree on a new `<prefix><name>` branch under `root/<repo folder>/<name>`,
 * from the `base` setting. Retries a name that is taken.
 */
export async function createWorktree(projectPath: string, root: string, base: string | undefined, prefix = 'gloss/'): Promise<{ path: string; branch: string }> {
  const start = await resolveBase(projectPath, base)
  // Git can't have both `dev` and `dev/x` branches.
  const folder = prefix.endsWith('/') ? prefix.slice(0, -1) : null
  if (folder && await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${folder}`]).then(() => true, () => false)) {
    throw new Error(`The branch ${folder} exists, so branches can't start with ${prefix}. Change the worktree branch prefix, for example to ${folder}-.`)
  }
  const repo = basename(resolve(projectPath))
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = worktreeName()
    const branch = `${prefix}${name}`
    const path = join(root, repo, name)
    if (existsSync(path)) continue
    const taken = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
    if (taken) continue
    await git(projectPath, ['worktree', 'add', '-b', branch, path, start], 120_000)
    return { path, branch }
  }
  throw new Error('Could not find a free name for the worktree.')
}

/** The branch prefix setting, ending in `/` (or `-`, `_`); `gloss/` when empty. */
export function branchPrefix(setting: string | undefined): string {
  const prefix = setting?.trim() ?? ''
  if (!prefix) return 'gloss/'
  return /[/_-]$/.test(prefix) ? prefix : `${prefix}/`
}

/** A branch name from a session's first message: its first words, lowercase and hyphenated, up to 40 characters. */
export function branchSlug(text: string): string {
  const words = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 40) break
    slug = next
  }
  return slug || (words[0]?.slice(0, 40) ?? '')
}

/**
 * Renames a worktree's branch to `<prefix><slug>`, or `<prefix><slug>-2` and so on when
 * that is taken. Resolves the new branch.
 */
export async function renameWorktreeBranch(path: string, from: string, prefix: string, slug: string): Promise<string> {
  for (let n = 1; n < 10; n++) {
    const branch = `${prefix}${slug}${n > 1 ? `-${n}` : ''}`
    if (branch === from) return from
    const taken = await git(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
    if (taken) continue
    await git(path, ['branch', '-m', from, branch])
    return branch
  }
  throw new Error(`Could not find a free branch name for ${slug}.`)
}

/**
 * Removes a worktree folder and its branch, whatever it holds: callers check unfinished
 * work or ask first. If git can't delete the folder, Node does, and git forgets it.
 */
export async function removeWorktree(projectPath: string, path: string, branch: string | null): Promise<void> {
  // Only ever delete a folder git lists as one of this project's worktrees (not the project folder).
  // Git expands Windows short paths (e.g. RUNNER~1), while callers may retain them.
  const canonicalPath = existsSync(path) ? realpathSync.native(path) : path
  const listed = (await listWorktrees(projectPath)).some((e) => !e.main && sameFolder(e.path, canonicalPath))
  if (listed) {
    // A failure can leave the folder half deleted (long paths): Node finishes it below.
    await git(projectPath, ['worktree', 'remove', '--force', path], 120_000).catch(() => {})
    if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } else if (existsSync(path)) {
    throw new Error(`${path} isn't a worktree of this project.`)
  }
  await git(projectPath, ['worktree', 'prune'])
  if (branch) await git(projectPath, ['branch', '-D', branch]).catch(() => {})
}
