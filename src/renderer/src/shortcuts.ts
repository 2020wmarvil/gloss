// Every keyboard shortcut, for the list on the settings screen (SPEC → Keyboard shortcuts).
// Only a description: each one is handled where it applies. Keep it in step with them.

export type Shortcut = {
  /** Alternatives, each a combination of keys. `Mod` is Ctrl, or Cmd on macOS. */
  keys: string[][]
  action: string
}

export type ShortcutGroup = { title: string; shortcuts: Shortcut[] }

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Anywhere',
    shortcuts: [
      { keys: [['Mod', 'N']], action: 'New session' },
      { keys: [['Mod', 'Tab'], ['Mod', 'PageDown']], action: 'Next session in the project' },
      { keys: [['Mod', 'Shift', 'Tab'], ['Mod', 'PageUp']], action: 'Previous session in the project' },
      { keys: [['Mod', 'L']], action: 'Focus the composer' },
      { keys: [['Mod', 'Shift', 'T']], action: 'Show or hide the side panel' },
      { keys: [['Mod', ',']], action: 'Open or close settings' },
      { keys: [['Esc']], action: 'Collapse the side panel, close settings or a menu' }
    ]
  },
  {
    title: 'Composer',
    shortcuts: [
      { keys: [['Enter']], action: 'Send, or queue while a turn runs' },
      { keys: [['Shift', 'Enter']], action: 'New line; on a bullet, the next bullet (on an empty one, end the list)' },
      { keys: [['*', 'Space']], action: 'At the start of a line, start a bulleted list' },
      { keys: [['Backspace']], action: 'Right after a bullet, remove it' },
      { keys: [['Mod', 'Enter']], action: 'Steer: send into the running turn now (agents that support it)' },
      { keys: [['/']], action: 'At the start, list the slash commands' },
      { keys: [['↑'], ['↓']], action: 'Move through the slash commands' },
      { keys: [['Tab'], ['Enter']], action: 'Complete the slash command (Enter on an exact match sends it)' },
      { keys: [['Esc']], action: 'Dismiss the slash commands' }
    ]
  },
  {
    title: 'Queued messages',
    shortcuts: [
      { keys: [['Enter']], action: 'Save the edit' },
      { keys: [['Esc']], action: 'Cancel the edit' }
    ]
  },
  {
    title: 'Conversation',
    shortcuts: [{ keys: [['R']], action: 'Reply to the selected text in a new thread' }]
  },
  {
    title: 'Session list',
    shortcuts: [
      { keys: [['Enter']], action: 'Open the focused session' },
      { keys: [['F2'], ['Double-click']], action: 'Rename the session' },
      { keys: [['Enter'], ['Esc']], action: 'While renaming: save, or cancel' }
    ]
  },
  {
    title: 'Panel edges',
    shortcuts: [
      { keys: [['←'], ['→']], action: 'Resize the sidebar or thread panel (with its edge focused)' },
      { keys: [['Double-click']], action: 'Reset its width' }
    ]
  }
]

/** What `Mod` reads as here. */
export function modKey(userAgent: string = navigator.userAgent): string {
  return /Mac/.test(userAgent) ? 'Cmd' : 'Ctrl'
}
