// The git branch of a session folder, for the status line.
import { execFile } from 'node:child_process'
import type { GitStatus } from '../shared/ipc'

/** Parses `git status --porcelain=v1 --branch`. */
export function parseGitStatus(output: string): GitStatus | null {
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

/** The folder's branch and whether it has uncommitted changes; null outside a repo or without git. */
export function gitStatus(cwd: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '--branch'],
      { cwd, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseGitStatus(stdout))
    )
  })
}
