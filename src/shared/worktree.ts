// Worktree sessions (SPEC → Worktrees): what the agent is told, and which project a session is in.

/**
 * The first line of a worktree session's first message, for the agent only: Gloss gives
 * some agents their instructions per process, so a session's folder can't go there.
 */
export function worktreeNote(path: string, branch: string | null, projectPath: string): string {
  const on = branch ? `, on branch ${branch}` : ''
  return `[You are working in a git worktree at ${path}${on}. The project folder is ${projectPath}.]`
}

export function isWorktreeNote(line: string): boolean {
  return line.startsWith('[You are working in a git worktree at ') && line.endsWith('.]')
}

/** An agent's title for a session without a leading worktree note (Codex titles a session with its first prompt). */
export function withoutWorktreeNote(title: string): string {
  const m = /^\[You are working in a git worktree at [^\]]*\.\]\s*/.exec(title)
  return m ? title.slice(m[0].length) : title
}

/** The project a session belongs to: its folder, or the project folder of the worktree it works in. */
export function projectOf(session: { cwd: string; project?: string }): string {
  return session.project ?? session.cwd
}
