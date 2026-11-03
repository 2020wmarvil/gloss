// Streamed text arrives as additions to a message the window already has (`messageText` events).
import type { Message } from './types'

/**
 * The messages with `text` added to `messageId` at `offset`. Unchanged (the same array) when
 * the message isn't there or doesn't end at `offset`: an addition it already has, or one
 * from before the log was loaded, which already included it.
 */
export function appendText(messages: Message[], messageId: string, offset: number, text: string): Message[] {
  const i = messages.findIndex((m) => m.id === messageId)
  if (i === -1 || messages[i].text.length !== offset) return messages
  const next = messages.slice()
  next[i] = { ...messages[i], text: messages[i].text + text }
  return next
}
