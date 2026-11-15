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

/** The rows the list shows for a query: a pasted repository first when it isn't one of the user's, then the matches. */
export function cloneChoices(repos: GithubRepo[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const matches = repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)).map((r) => r.fullName)
  const pasted = parseGithubRepo(query)
  const known = pasted && repos.find((r) => r.fullName.toLowerCase() === pasted.toLowerCase())?.fullName
  if (known) return [known, ...matches.filter((m) => m !== known)]
  return pasted ? [pasted, ...matches] : matches
}
