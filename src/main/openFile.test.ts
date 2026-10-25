import { describe, expect, it } from 'vitest'
import { draftEditorArgs, editorArgs, splitArgs, windowsCommandLine } from './openFile'

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

  it('waits for prompt files to close without changing ordinary file-opening commands', () => {
    expect(draftEditorArgs('code -g {file}:{line}', '/tmp/prompt.md')).toEqual(['code', '--wait', '-g', '/tmp/prompt.md:1'])
    expect(draftEditorArgs('code --wait {file}', '/tmp/prompt.md')).toEqual(['code', '--wait', '/tmp/prompt.md'])
    expect(draftEditorArgs('"C:/Program Files/Code/bin/code.cmd" -w {file}', '/tmp/prompt.md')).toEqual(['C:/Program Files/Code/bin/code.cmd', '-w', '/tmp/prompt.md'])
    expect(draftEditorArgs('kate {file}', '/tmp/prompt.md')).toEqual(['kate', '--block', '/tmp/prompt.md'])
    expect(draftEditorArgs('notepad++ {file}', '/tmp/prompt.md')).toContain('-multiInst')
    expect(editorArgs('code -g {file}:{line}', '/tmp/prompt.md', 1)).not.toContain('--wait')
  })
})
