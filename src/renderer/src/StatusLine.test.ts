import { describe, expect, it } from 'vitest'
import { modelLabel } from './StatusLine'

describe('modelLabel', () => {
  it("names the model behind an agent's default option", () => {
    expect(modelLabel({ value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' })).toBe('Opus 5.5')
  })

  it('uses the name otherwise', () => {
    expect(modelLabel({ value: 'opus', name: 'Opus 5.5', description: 'For complex work' })).toBe('Opus 5.5')
    expect(modelLabel({ value: 'default', name: 'Default' })).toBe('Default')
  })
})

describe('option names', () => {
  it('reads effort ids and drops a description that repeats the name', async () => {
    const { optionName, optionDescription } = await import('./StatusLine')
    expect(optionName('Xhigh')).toBe('Extra high')
    expect(optionName('Medium')).toBe('Medium')
    expect(optionDescription('Opus 5.5', 'Opus 5.5 · Best for everyday tasks')).toBe('Best for everyday tasks')
    expect(optionDescription('Default (recommended)', 'Opus')).toBe('Opus')
    expect(optionDescription('Haiku', 'Haiku')).toBeNull()
  })
})
