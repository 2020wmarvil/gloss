import { describe, expect, it } from 'vitest'
import { chatsFolder } from './chats'

describe('chatsFolder', () => {
  it('is the chats folder next to settings.json', () => {
    expect(chatsFolder('C:\\Users\\me\\AppData\\Roaming\\Gloss\\settings.json')).toBe('C:\\Users\\me\\AppData\\Roaming\\Gloss\\chats')
    expect(chatsFolder('/home/me/.config/Gloss/settings.json')).toBe('/home/me/.config/Gloss/chats')
  })
})
