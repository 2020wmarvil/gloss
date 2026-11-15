import { describe, expect, it } from 'vitest'
import { nativePath, nativePaths } from './acp'

describe('nativePath', () => {
  it("turns Antigravity's URL-style Windows paths into Windows paths, on Windows only", () => {
    expect(nativePath('/C:/Users/u/project/a.ts', 'win32')).toBe('C:\\Users\\u\\project\\a.ts')
    expect(nativePath('C:\\Users\\u\\a.ts', 'win32')).toBe('C:\\Users\\u\\a.ts')
    expect(nativePath('/home/u/a.ts', 'win32')).toBe('/home/u/a.ts')
    expect(nativePath('/C:/Users/u/a.ts', 'linux')).toBe('/C:/Users/u/a.ts')
  })

  it("fixes a tool call's locations and diffs, and leaves other updates alone", () => {
    const update = nativePaths({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        title: 'File /C:/w/one.txt',
        locations: [{ path: '/C:/w/one.txt' }],
        content: [
          { type: 'diff', path: '/C:/w/one.txt', oldText: 'a', newText: 'b' },
          { type: 'content', content: { type: 'text', text: '/C:/w/one.txt' } }
        ]
      }
    }, 'win32').update
    expect(update).toMatchObject({
      title: 'File C:\\w\\one.txt',
      locations: [{ path: 'C:\\w\\one.txt' }],
      content: [{ type: 'diff', path: 'C:\\w\\one.txt' }, { type: 'content', content: { text: '/C:/w/one.txt' } }]
    })
    const text = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: '/C:/x' } } }
    expect(nativePaths(text, 'win32')).toBe(text)
  })
})
