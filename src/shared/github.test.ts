import { describe, expect, it } from 'vitest'
import { parseGithubRepo } from './github'

describe('parseGithubRepo', () => {
  it('takes owner/name, pages and clone URLs', () => {
    for (const text of [
      'acme/widgets',
      ' acme/widgets.git ',
      'https://github.com/acme/widgets',
      'github.com/acme/widgets/',
      'https://www.github.com/acme/widgets/tree/main/src',
      'https://github.com/acme/widgets/pull/12',
      'https://github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets'
    ])
      expect(parseGithubRepo(text), text).toBe('acme/widgets')
    expect(parseGithubRepo('acme/my.repo-2')).toBe('acme/my.repo-2')
  })

  it('refuses anything else', () => {
    for (const text of ['', 'widgets', 'https://gitlab.com/acme/widgets', 'acme/widgets/extra', '../widgets', 'acme/..', 'a b/c'])
      expect(parseGithubRepo(text), text).toBeNull()
  })
})
