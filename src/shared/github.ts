// Opening a project from GitHub (SPEC → Projects and sessions): which repository a typed or pasted name means.

/** One of the user's repositories, from `gh api user/repos`. */
export type GithubRepo = {
  /** `owner/name`. */
  fullName: string
  description: string | null
  private: boolean
  fork: boolean
  archived: boolean
  /** Last push, ms since the epoch. */
  pushedAt: number
}

/**
 * The `owner/name` a pasted repository means: `owner/name`, its github.com page (any page
 * inside it too) or a clone URL (https, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`).
 * Null for anything else.
 */
export function parseGithubRepo(text: string): string | null {
  const s = text.trim()
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s)
  const url = /^(?:(?:https?:\/\/)?(?:www\.)?(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(s)
  const m = url ?? short
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null
  return `${m[1]}/${m[2]}`
}
