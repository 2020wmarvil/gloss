import { describe, expect, it } from 'vitest'
import type { Message, Session, Thread, ToolCall } from '../shared/types'
import { toMarkdown } from './export'
import { combineChecks, githubRepoUrl, parseGitStatus, parsePullRequest } from './git'

const session: Session = { id: 's', agentId: 'a', acpSessionId: 'x', cwd: '/w', title: 'Order review', createdAt: 0 }
const msg = (seq: number, role: Message['role'], text: string, threadId: string | null = null): Message => ({
  id: `m${seq}`,
  sessionId: 's',
  seq,
  role,
  text,
  threadId
})
const messages: Message[] = [
  { ...msg(0, 'user', 'Review it'), attachments: [{ kind: 'file', name: 'notes.md', text: 'x' }] },
  msg(2, 'agent', '1. Cache race\n2. N+1 query'),
  msg(3, 'user', 'Show the interleaving', 't1'),
  msg(4, 'agent', 'Writer invalidates, then...', 't1')
]
const toolCalls: ToolCall[] = [
  { id: 'tc', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read orders.ts', status: 'completed' }
]
const threads: Thread[] = [
  { id: 't1', sessionId: 's', anchorMessageId: 'm2', anchor: { kind: 'listItem', path: [0], text: 'Cache race' }, createdAt: 0 },
  { id: 't2', sessionId: 's', anchorMessageId: 'm2', anchor: { kind: 'listItem', path: [1], text: 'N+1 query' }, createdAt: 0 }
]
const log = { session, messages, toolCalls, threads }

describe('toMarkdown', () => {
  it('exports the main thread, then each thread with replies', () => {
    expect(toMarkdown(log, null)).toBe(
      [
        '# Order review',
        '**You**\n\nReview it\n\n_Attached: notes.md_',
        '_Tool: Read orders.ts (completed)_',
        '**Agent**\n\n1. Cache race\n2. N+1 query',
        '## Thread: “Cache race”',
        '> Cache race',
        '**You**\n\nShow the interleaving',
        '**Agent**\n\nWriter invalidates, then...'
      ].join('\n\n') + '\n'
    )
  })

  it('exports one thread', () => {
    expect(toMarkdown(log, 't1')).toBe(
      [
        '# Thread: “Cache race”',
        'From Order review',
        '> Cache race',
        '**You**\n\nShow the interleaving',
        '**Agent**\n\nWriter invalidates, then...'
      ].join('\n\n') + '\n'
    )
  })
})

describe('parseGitStatus', () => {
  it('reads the branch and whether the tree is dirty', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n')).toEqual({ branch: 'main', dirty: false })
    expect(parseGitStatus('## dev\n M src/a.ts\n?? b.ts\n')).toEqual({ branch: 'dev', dirty: true })
    expect(parseGitStatus('## No commits yet on main\n')).toEqual({ branch: 'main', dirty: false })
    expect(parseGitStatus('## HEAD (no branch)\n')).toEqual({ branch: 'detached HEAD', dirty: false })
    expect(parseGitStatus('')).toBeNull()
  })
})

describe('githubRepoUrl', () => {
  it('reads GitHub remotes in each URL form', () => {
    expect(githubRepoUrl('https://github.com/o/r')).toBe('https://github.com/o/r')
    expect(githubRepoUrl('https://github.com/o/r.git\n')).toBe('https://github.com/o/r')
    expect(githubRepoUrl('git@github.com:o/my.repo.git')).toBe('https://github.com/o/my.repo')
    expect(githubRepoUrl('ssh://git@github.com/o/r.git')).toBe('https://github.com/o/r')
    expect(githubRepoUrl('https://gitlab.com/o/r.git')).toBeNull()
  })
})

describe('parsePullRequest', () => {
  const run = (conclusion: string) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion })
  it('reads gh pr view output', () => {
    const out = JSON.stringify({
      number: 13,
      title: 'M9',
      url: 'https://github.com/o/r/pull/13',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
      statusCheckRollup: [run('SUCCESS'), run('SKIPPED')],
      headRefOid: 'abc',
      baseRefName: 'main'
    })
    expect(parsePullRequest(out, 'def')).toEqual({
      number: 13,
      title: 'M9',
      url: 'https://github.com/o/r/pull/13',
      state: 'open',
      checks: 'passing',
      review: null,
      baseRef: 'main'
    })
    expect(parsePullRequest(out.replace('"OPEN","isDraft":false', '"OPEN","isDraft":true'), 'def')?.state).toBe('draft')
    expect(parsePullRequest('no pull requests found', 'abc')).toBeNull()
  })
  it('keeps a merged or closed PR only while the branch is still at its last commit', () => {
    const out = (state: string): string =>
      JSON.stringify({ number: 13, title: 'M9', url: 'https://github.com/o/r/pull/13', state, isDraft: false, headRefOid: 'abc' })
    expect(parsePullRequest(out('MERGED'), 'abc')?.state).toBe('merged')
    expect(parsePullRequest(out('CLOSED'), 'abc')?.state).toBe('closed')
    expect(parsePullRequest(out('MERGED'), 'def')).toBeNull()
    expect(parsePullRequest(out('CLOSED'), null)).toBeNull()
  })
  it('combines checks', () => {
    expect(combineChecks([])).toBeNull()
    expect(combineChecks([run('SUCCESS'), { status: 'IN_PROGRESS' }])).toBe('pending')
    expect(combineChecks([run('FAILURE'), { status: 'QUEUED' }])).toBe('failing')
    expect(combineChecks([{ state: 'PENDING' }, run('SUCCESS')])).toBe('pending')
    expect(combineChecks([{ state: 'SUCCESS' }, run('NEUTRAL')])).toBe('passing')
  })
})
