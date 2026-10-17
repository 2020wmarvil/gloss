import { describe, expect, it } from 'vitest'
import { allowForeground } from './foreground'

describe('allowForeground', () => {
  it('does nothing off Windows', async () => {
    await expect(allowForeground('linux')).resolves.toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('calls user32 on Windows without failing', async () => {
    await expect(allowForeground('win32')).resolves.toBeUndefined()
    await expect(allowForeground('win32')).resolves.toBeUndefined()
  })
})
