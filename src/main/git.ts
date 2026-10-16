// The git branch of a session folder and its GitHub pull request, for the status line.
import { execFile } from 'node:child_process'
import type { GitStatus, PullRequest } from '../shared/ipc'

/** Runs a command in `cwd`; resolves its stdout, or null if it fails or isn't installed. */
function run(cmd: string, args: string[], cwd: string, timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

/** Parses `git status --porcelain=v1 --branch`. */
export function parseGitStatus(output: string): Omit<GitStatus, 'url'> | null {
  const [head, ...rest] = output.split('\n')
  if (!head?.startsWith('## ')) return null
  const info = head.slice(3)
  let branch: string
  const noCommits = /^No commits yet on (.+)$/.exec(info)
  if (noCommits) branch = noCommits[1]
  else if (info.startsWith('HEAD (no branch)')) branch = 'detached HEAD'
  else branch = info.split('...')[0].split(' ')[0]
  return { branch, dirty: rest.some((line) => line.trim() !== '') }
}

/**
 * The web page of a GitHub repository from a remote URL (https, `git@github.com:o/r.git`
 * or `ssh://git@github.com/o/r`); null for other hosts.
 */
export function githubRepoUrl(remote: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

/** The GitHub page of the folder's `origin` remote; null without one or off GitHub. */
export async function originRepoUrl(cwd: string): Promise<string | null> {
  const remoteUrl = await run('git', ['remote', 'get-url', 'origin'], cwd)
  return remoteUrl ? githubRepoUrl(remoteUrl) : null
}

/** The page of `branch`'s upstream on GitHub; null without an upstream or off GitHub. */
async function branchUrl(cwd: string, branch: string): Promise<string | null> {
  const upstream = await run('git', ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`], cwd)
  const [remote, ref] = (upstream ?? '').trim().split('\0')
  if (!remote || !ref?.startsWith('refs/heads/')) return null
  const remoteUrl = await run('git', ['remote', 'get-url', remote], cwd)
  const repo = remoteUrl ? githubRepoUrl(remoteUrl) : null
  return repo ? `${repo}/tree/${ref.slice('refs/heads/'.length).split('/').map(encodeURIComponent).join('/')}` : null
}

/** The folder's branch, whether it has uncommitted changes and its GitHub page; null outside a repo or without git. */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  const output = await run('git', ['status', '--porcelain=v1', '--branch'], cwd)
  const status = output === null ? null : parseGitStatus(output)
  if (!status) return null
  const url = status.branch === 'detached HEAD' ? null : await branchUrl(cwd, status.branch)
  return { ...status, url }
}

type CheckRollupItem = { status?: string; conclusion?: string; state?: string }

/**
 * Combines `statusCheckRollup`: CheckRuns have `status` (COMPLETED when done) and
 * `conclusion`; commit StatusContexts have `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED).
 */
export function combineChecks(items: CheckRollupItem[]): PullRequest['checks'] {
  if (items.length === 0) return null
  const results = items.map((c) => (c.state ?? (c.status === 'COMPLETED' ? c.conclusion : 'PENDING') ?? 'PENDING').toUpperCase())
  const failed = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  if (results.some((r) => failed.includes(r))) return 'failing'
  if (results.some((r) => r === 'PENDING' || r === 'EXPECTED' || r === '')) return 'pending'
  return 'passing'
}

const PR_FIELDS = 'number,title,state,isDraft,url,statusCheckRollup,reviewDecision,headRefOid,baseRefName'

/**
 * Parses `gh pr view --json <PR_FIELDS>`. `gh` also finds a branch's merged or closed
 * PR, which is stale once the branch moves on (a long-lived `dev`), so one of those
 * only counts while its last commit is still `head`.
 */
export function parsePullRequest(output: string, head: string | null): PullRequest | null {
  try {
    const pr = JSON.parse(output) as {
      number?: number
      title?: string
      url?: string
      state?: string
      isDraft?: boolean
      statusCheckRollup?: CheckRollupItem[] | null
      reviewDecision?: string
      headRefOid?: string
      baseRefName?: string
    }
    if (typeof pr.number !== 'number' || typeof pr.url !== 'string' || !pr.url.startsWith('https://')) return null
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open'
    if ((state === 'merged' || state === 'closed') && (!head || pr.headRefOid !== head)) return null
    const review =
      pr.reviewDecision === 'APPROVED'
        ? 'approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes requested'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review required'
            : null
    return {
      number: pr.number,
      title: pr.title ?? '',
      url: pr.url,
      state,
      checks: combineChecks(pr.statusCheckRollup ?? []),
      review,
      baseRef: pr.baseRefName ?? ''
    }
  } catch {
    return null
  }
}

/** The pull request for the folder's branch, from `gh`; null without one, or without `gh` or its login. */
export async function pullRequest(cwd: string): Promise<PullRequest | null> {
  const [output, head] = await Promise.all([
    run('gh', ['pr', 'view', '--json', PR_FIELDS], cwd, 15000),
    run('git', ['rev-parse', 'HEAD'], cwd)
  ])
  return output === null ? null : parsePullRequest(output, head?.trim() || null)
}
