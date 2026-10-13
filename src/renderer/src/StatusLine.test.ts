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
