import { expect, it } from 'vitest'
import type { GithubRepo } from '@shared/github'
import { byOwner, cloneChoices } from './CloneDialog'

const repo = (fullName: string, description: string | null = null): GithubRepo => ({ fullName, description, private: false, fork: false, archived: false, pushedAt: 0 })
const repos = [repo('me/gloss', 'Threads for agents'), repo('acme/widgets'), repo('me/notes')]

it('filters by name and description, and puts a pasted repository first', () => {
  expect(cloneChoices(repos, '')).toEqual(['me/gloss', 'acme/widgets', 'me/notes'])
  expect(cloneChoices(repos, 'NOTES')).toEqual(['me/notes'])
  expect(cloneChoices(repos, 'agents')).toEqual(['me/gloss'])
  expect(cloneChoices(repos, 'https://github.com/other/thing')).toEqual(['other/thing'])
  // One of the user's own, pasted as a URL in another case: listed once, under its own name.
  expect(cloneChoices(repos, 'https://github.com/ACME/widgets.git')).toEqual(['acme/widgets'])
  expect(cloneChoices(repos, 'me/notes')).toEqual(['me/notes'])
})

it('groups repositories by owner in the order owners first appear', () => {
  expect(byOwner(['me/a', 'acme/x', 'Me/b', 'acme/y'])).toEqual([
    { owner: 'me', names: ['me/a', 'Me/b'] },
    { owner: 'acme', names: ['acme/x', 'acme/y'] }
  ])
})
