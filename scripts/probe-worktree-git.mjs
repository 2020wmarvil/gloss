// Worktree spike, git side. Works in a throwaway repository under the temp folder only.
// Usage: node scripts/probe-worktree-git.mjs
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'gloss-worktree-probe-'))
const repo = join(root, 'project')
const remote = join(root, 'remote.git')
// Stands in for ~/.gloss/worktrees/<repo>/<name>.
const home = join(root, 'home', '.gloss', 'worktrees', 'project')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (cwd, ...args) => {
  try { return { ok: true, out: git(cwd, ...args) } } catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() } }
}
const results = {}

try {
  mkdirSync(repo)
  git(root, 'init', '-q', '--bare', remote)
  git(repo, 'init', '-q', '-b', 'dev')
  git(repo, 'config', 'user.email', 'probe@example.com')
  git(repo, 'config', 'user.name', 'Probe')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'dev')

  // Create: a new branch off the project folder's current branch, in a folder outside the repo.
  const wt = join(home, 'k3f9')
  results.add = tryGit(repo, 'worktree', 'add', '-b', 'gloss/k3f9', wt, 'dev')
  results.list = git(repo, 'worktree', 'list', '--porcelain')
  results.listFromWorktree = git(wt, 'worktree', 'list', '--porcelain') === results.list
  results.commonDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  results.toplevelInWorktree = git(wt, 'rev-parse', '--show-toplevel')
  results.branchCheckedOutElsewhere = tryGit(repo, 'checkout', 'gloss/k3f9')

  // Unfinished work: ignored files don't count, untracked ones do.
  mkdirSync(join(wt, 'node_modules', ...Array(30).fill('deep-package-name')), { recursive: true })
  const deep = join(wt, 'node_modules', ...Array(30).fill('deep-package-name'), 'index.js')
  writeFileSync(deep, '//\n')
  results.longPathLength = deep.length
  results.statusWithIgnoredOnly = git(wt, 'status', '--porcelain')
  writeFileSync(join(wt, 'new.txt'), 'new\n')
  results.statusWithUntracked = git(wt, 'status', '--porcelain')
  results.removeWithUntracked = tryGit(repo, 'worktree', 'remove', wt)
  git(wt, 'add', 'new.txt')
  git(wt, 'commit', '-q', '-m', 'work')
  results.unpushedCount = git(repo, 'rev-list', '--count', 'gloss/k3f9', '--not', '--remotes')
  git(wt, 'push', '-q', '-u', 'origin', 'gloss/k3f9')
  results.unpushedAfterPush = git(repo, 'rev-list', '--count', 'gloss/k3f9', '--not', '--remotes')
  // A squash merge deletes the remote branch: the commits look unpushed again.
  git(repo, 'push', '-q', 'origin', '--delete', 'gloss/k3f9')
  git(repo, 'fetch', '-q', '--prune')
  results.unpushedAfterRemoteDelete = git(repo, 'rev-list', '--count', 'gloss/k3f9', '--not', '--remotes')

  // Remove: clean except ignored files.
  results.removeWithIgnoredOnly = tryGit(repo, 'worktree', 'remove', wt)
  results.stillListedAfterFailedRemove = git(repo, 'worktree', 'list', '--porcelain').includes('k3f9')
  results.removeWithLongPaths = tryGit(repo, '-c', 'core.longpaths=true', 'worktree', 'remove', wt)
  results.folderGoneAfterRemove = !existsSync(wt)
  results.listedAfterRemove = git(repo, 'worktree', 'list', '--porcelain').includes('k3f9')

  // The other way out: delete the folder from Node (which handles long paths), then prune.
  const wtNode = join(home, 'n0de')
  git(repo, 'worktree', 'add', '-q', '-b', 'gloss/n0de', wtNode, 'dev')
  mkdirSync(join(wtNode, 'node_modules', ...Array(30).fill('deep-package-name')), { recursive: true })
  writeFileSync(join(wtNode, 'node_modules', ...Array(30).fill('deep-package-name'), 'index.js'), '//\n')
  rmSync(wtNode, { recursive: true, force: true })
  git(repo, 'worktree', 'prune')
  results.nodeDeleteThenPrune = !git(repo, 'worktree', 'list', '--porcelain').includes('n0de')
  git(repo, 'branch', '-D', 'gloss/n0de')
  const wtLong = join(home, 'l0ng')
  git(repo, 'worktree', 'add', '-q', '-b', 'gloss/l0ng', wtLong, 'dev')
  mkdirSync(join(wtLong, 'node_modules', ...Array(30).fill('deep-package-name')), { recursive: true })
  writeFileSync(join(wtLong, 'node_modules', ...Array(30).fill('deep-package-name'), 'index.js'), '//\n')
  results.freshRemoveWithLongPaths = tryGit(repo, '-c', 'core.longpaths=true', 'worktree', 'remove', wtLong)
  results.freshLongPathsFolderGone = !existsSync(wtLong)
  results.deleteMergedLooking = tryGit(repo, 'branch', '-d', 'gloss/k3f9')
  results.deleteForced = tryGit(repo, 'branch', '-D', 'gloss/k3f9')

  // Forced removal with uncommitted work, and a folder deleted behind git's back.
  const wt2 = join(home, 'p82d')
  git(repo, 'worktree', 'add', '-q', '-b', 'gloss/p82d', wt2, 'dev')
  writeFileSync(join(wt2, 'a.txt'), 'changed\n')
  results.removeDirty = tryGit(repo, 'worktree', 'remove', wt2)
  results.removeDirtyForced = tryGit(repo, 'worktree', 'remove', '--force', wt2)
  const wt3 = join(home, 'zz11')
  git(repo, 'worktree', 'add', '-q', '-b', 'gloss/zz11', wt3, 'dev')
  rmSync(wt3, { recursive: true, force: true })
  results.listAfterManualDelete = git(repo, 'worktree', 'list', '--porcelain')
  results.prune = tryGit(repo, 'worktree', 'prune')
  results.listAfterPrune = git(repo, 'worktree', 'list', '--porcelain')
  // A branch name that already exists.
  results.addExistingBranch = tryGit(repo, 'worktree', 'add', '-b', 'dev', join(home, 'dup'), 'dev')
  results.gitVersion = git(repo, '--version')
  console.log(JSON.stringify(results, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
