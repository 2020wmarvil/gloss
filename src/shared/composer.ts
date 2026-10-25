export type ContextItem = {
  kind: 'file' | 'folder' | 'diff' | 'chat' | 'terminal'
  id: string
  label: string
  description: string
  /** Selecting this directory continues path completion instead of attaching its contents. */
  browse?: boolean
}

export type ShellResult = { command: string; output: string; exitCode: number | null; truncated: boolean }
