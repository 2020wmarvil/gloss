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
      { keys: [['Mod', 'Shift', 'F']], action: 'Search conversations' },
      { keys: [['Mod', 'N']], action: 'New session' },
      { keys: [['Mod', 'Tab'], ['Mod', 'PageDown']], action: 'Next session in the project' },
      { keys: [['Mod', 'Shift', 'Tab'], ['Mod', 'PageUp']], action: 'Previous session in the project' },
      { keys: [['Mod', 'L']], action: 'Focus the composer' },
      { keys: [['Mod', 'Shift', 'T']], action: 'Show or hide the side panel' },
      { keys: [['Mod', 'J']], action: 'Go to where the agent is working, or last worked' },
      { keys: [['Mod', 'Shift', 'Q']], action: 'Show the queue' },
      { keys: [['Ctrl', 'Shift', 'PrtSc']], action: 'Capture part of the screen for the composer used last, in Gloss or any app (the default; change it under Capture shortcut)' },
      { keys: [['Mod', ',']], action: 'Open or close settings' },
      { keys: [['Alt', '←'], ['Mouse back']], action: 'Back to the previous session, thread or settings' },
      { keys: [['Alt', '→'], ['Mouse forward']], action: 'Forward again' },
      { keys: [['Esc']], action: 'Close settings or a menu' },
      { keys: [['F11']], action: 'Full screen, or back to a window (Ctrl+Cmd+F on macOS)' }
    ]
  },
  {
    title: 'Composer',
    shortcuts: [
      { keys: [['Enter']], action: 'Send: steer the active thread, or queue for another thread (inside a ``` code block, a new line)' },
      { keys: [['Shift', 'Enter']], action: 'New line; in a list, the next item (on an empty item, end the list)' },
      { keys: [['Backspace']], action: 'Right after a list marker or ">", remove it' },
      { keys: [['Tab'], ['Shift', 'Tab']], action: 'In a list, indent or outdent the item' },
      { keys: [['Mod', 'B']], action: 'Bold' },
      { keys: [['Mod', 'I']], action: 'Italic' },
      { keys: [['Mod', 'E']], action: 'Inline code' },
      { keys: [['Mod', 'K']], action: 'Link (pasting a URL over selected text also makes a link)' },
      { keys: [['Mod', 'Z'], ['Mod', 'Shift', 'Z']], action: 'Undo, redo' },
      { keys: [['Mod', 'Enter']], action: 'Send, including inside a code block (steers the active thread when supported)' },
      { keys: [['Alt', 'Enter']], action: 'Queue for after the running turn, instead of steering it' },
      { keys: [['/']], action: 'At the start, list the slash commands' },
      { keys: [['↑'], ['↓']], action: 'Move through the slash commands' },
      { keys: [['Tab'], ['Enter']], action: 'Complete the slash command (Enter on an exact match sends it)' },
      { keys: [['Esc']], action: 'Dismiss the slash commands; otherwise, in the working thread, cancel the turn' }
    ]
  },
  {
    title: 'Screen capture',
    shortcuts: [
      { keys: [['Drag']], action: 'Capture a region (hold Shift for a square)' },
      { keys: [['Click']], action: 'Capture the window under the cursor, or the whole display over the desktop' },
      { keys: [['Space']], action: 'Capture the whole display under the cursor' },
      { keys: [['←'], ['→'], ['↑'], ['↓']], action: 'Nudge the cursor a pixel (with Shift, 10)' },
      { keys: [['Right-click']], action: 'Drop the region being drawn, or cancel' },
      { keys: [['Esc']], action: 'Cancel' }
    ]
  },
  {
    title: 'Annotating a capture',
    shortcuts: [
      { keys: [['N']], action: 'Pin: click to place a numbered pin, drag one to move it' },
      { keys: [['F']], action: 'Pen' },
      { keys: [['H']], action: 'Highlighter' },
      { keys: [['R']], action: 'Box' },
      { keys: [['A']], action: 'Arrow' },
      { keys: [['Mod', 'Z'], ['Mod', 'Y']], action: 'Undo, redo' },
      { keys: [['Mod', 'Wheel'], ['+'], ['-']], action: 'Zoom in or out (at the cursor with the wheel)' },
      { keys: [['0'], ['1']], action: 'Fit the window, actual size' },
      { keys: [['Space', 'Drag'], ['Middle-drag']], action: 'Pan (the wheel scrolls too)' },
      { keys: [['Mod', 'Enter']], action: 'Add it to the message' },
      { keys: [['Esc']], action: 'Leave a note, or cancel' }
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
    title: 'Questions and approvals (while the card has focus)',
    shortcuts: [
      { keys: [['1'], ['…'], ['9']], action: 'Approval: pick that option. Question: pick or unpick that choice in the focused (or first) choice' },
      { keys: [['Enter']], action: 'Approval: allow once. Question: submit' },
      { keys: [['Esc']], action: 'Approval: reject once. Question: decline' }
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
