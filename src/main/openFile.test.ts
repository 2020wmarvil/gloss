import { describe, expect, it } from 'vitest'
import { editorArgs, splitArgs, windowsCommandLine } from './openFile'

describe('editor command', () => {
  it('splits a command line, keeping quoted parts together', () => {
    expect(splitArgs('code -g  {file}:{line}')).toEqual(['code', '-g', '{file}:{line}'])
    expect(splitArgs('"C:/Program Files/Notepad++/notepad++.exe" -n{line} ""')).toEqual(['C:/Program Files/Notepad++/notepad++.exe', '-n{line}', ''])
  })

  it('fills in the file and line, or appends the file', () => {
    expect(editorArgs('code -g {file}:{line}', 'C:/r/a b.ts', 12)).toEqual(['code', '-g', 'C:/r/a b.ts:12'])
    expect(editorArgs('subl', '/r/a.ts', 3)).toEqual(['subl', '/r/a.ts'])
    expect(editorArgs('  ', '/r/a.ts', 3)).toEqual([])
  })

  it('quotes for cmd.exe and refuses paths it would expand', () => {
    expect(windowsCommandLine(['code', '-g', 'C:/r/a b.ts:12'], 'C:/r/a b.ts')).toBe('code -g "C:/r/a b.ts:12"')
    expect(windowsCommandLine(['code', 'C:/r/x&y.ts'], 'C:/r/x&y.ts')).toBe('code "C:/r/x&y.ts"')
    expect(() => windowsCommandLine(['code', 'C:/r/%PATH%.ts'], 'C:/r/%PATH%.ts')).toThrow('%')
  })
})
