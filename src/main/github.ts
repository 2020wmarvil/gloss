// Opening a project from GitHub (SPEC → Projects and sessions): the user's repositories and cloning one, through `gh`.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { githubRepoUrl } from './git'
import { parseGithubRepo, type GithubRepo } from '../shared/github'

const NO_GH = 'Opening a project from GitHub needs the GitHub CLI (gh), signed in with `gh auth login`.'

/** Runs `cmd`; resolves its stdout, or rejects with its stderr (or why it couldn't start). */
function run(cmd: string, args: string[], cwd: string | undefined, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(NO_GH))
      reject(new Error(stderr.trim() || err.message))
    })
  })
}

/** Parses the JSON lines of `gh api … --jq` (one repository per line), most recently pushed first. */
export function parseRepos(output: string): GithubRepo[] {
  const repos = new Map<string, GithubRepo>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line) as { full_name: string; description: string | null; private: boolean; fork: boolean; archived: boolean; pushed_at: string | null }
    repos.set(r.full_name, {
      fullName: r.full_name,
      description: r.description || null,
      private: r.private,
      fork: r.fork,
      archived: r.archived,
      pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0
    })
  }
  return [...repos.values()].sort((a, b) => b.pushedAt - a.pushedAt)
}

/** The repositories the signed-in user owns, collaborates on or can see through an organization. */
export async function listRepos(): Promise<GithubRepo[]> {
  try {
    const output = await run(
      'gh',
      [
        'api',
        '--paginate',
        'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
        '--jq',
        '.[] | {full_name, description, private, fork, archived, pushed_at}'
      ],
      undefined,
      60000
    )
    return parseRepos(output)
  } catch (err) {
    // Signed out: gh says to run `gh auth login`, which is what NO_GH says too.
    if (err instanceof Error && /gh auth login|not logged in/i.test(err.message)) throw new Error(NO_GH, { cause: err })
    throw err
  }
}

/**
 * Clones `repo` (`owner/name`, or anything `parseGithubRepo` takes) into `parent/<name>` and
 * resolves to that folder. A folder there that is already a clone of it is used as it is;
 * anything else there is an error.
 */
export async function cloneRepo(repo: string, parent: string): Promise<string> {
  const fullName = parseGithubRepo(repo)
  if (!fullName) throw new Error(`${repo} isn't a GitHub repository`)
  const dest = join(parent, fullName.split('/')[1])
  // git clones into an empty folder.
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    const origin = await run('git', ['remote', 'get-url', 'origin'], dest, 5000).catch(() => null)
    const page = origin ? githubRepoUrl(origin) : null
    if (page?.toLowerCase() === `https://github.com/${fullName}`.toLowerCase()) return dest
    throw new Error(`${dest} already exists`)
  }
  await run('gh', ['repo', 'clone', fullName, dest], parent, 30 * 60 * 1000)
  return dest
}
