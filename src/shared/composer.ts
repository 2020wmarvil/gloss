import type { Attachment, TurnOutcome } from './types'

export type ContextItem = {
  kind: 'file' | 'folder' | 'diff' | 'chat' | 'terminal'
  id: string
  label: string
  description: string
  /** Selecting this directory continues path completion instead of attaching its contents. */
  browse?: boolean
}

export type ShellResult = { command: string; output: string; exitCode: number | null; truncated: boolean }

export type RewindPoint = {
  id: string
  text: string
  threadId: string | null
  createdAt?: number
  laterMessages?: number
  sessionTitle?: string
  outcome?: TurnOutcome
}

export type RewindDraft = { text: string; attachments: Attachment[] }
