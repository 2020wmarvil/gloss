// The wire format for thread messages (SPEC → Wire format).
import type { Anchor } from './types'

export const WIRE_ANCHOR_LENGTH = 80

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The tag that prefixes a thread message so the agent knows what it refers to. */
export function wireTag(anchorText: string): string {
  return `[re: "${truncate(anchorText, WIRE_ANCHOR_LENGTH)}"]`
}

/** The tag on a thread reply sent to the main conversation ("Send to main"): about that point, but no longer in its thread. */
export function toMainTag(anchorText: string): string {
  return `[re: "${truncate(anchorText, WIRE_ANCHOR_LENGTH)}", continued in the main conversation]`
}

/** What a thread's tags quote: the anchor text, after the file and lines for diff lines. */
function quoted(anchor: Anchor): string {
  const text = `"${truncate(anchor.text, WIRE_ANCHOR_LENGTH)}"`
  if (anchor.kind !== 'line') return text
  const range = anchor.start === anchor.end ? `${anchor.start}` : `${anchor.start}-${anchor.end}`
  return `${anchor.file}:${range}${anchor.side === 'old' ? ' (old)' : ''} ${text}`
}

/** The tag of a thread's messages: `[re: "<text>"]`, or `[re: path:line "<text>"]` for diff lines. */
export function threadTag(anchor: Anchor): string {
  return `[re: ${quoted(anchor)}]`
}

/** The tag of a reply sent to the main conversation from a thread. */
export function threadToMainTag(anchor: Anchor): string {
  return `[re: ${quoted(anchor)}, continued in the main conversation]`
}

/** The tag on the first main-thread message after a thread, so the agent knows the thread is over. */
export const MAIN_TAG = '[re: the main conversation, not the thread above]'

/**
 * What is sent to the agent: thread messages tagged with their anchor, main-thread
 * messages unchanged unless they follow a thread (`afterThread`) or were sent to the
 * main conversation from one (`fromAnchor`, that thread's anchor).
 */
export function wireText(
  text: string,
  anchor: Anchor | null,
  afterThread = false,
  fromAnchor: Anchor | null = null
): string {
  if (anchor !== null) return `${threadTag(anchor)}\n${text}`
  if (fromAnchor !== null) return `${threadToMainTag(fromAnchor)}\n${text}`
  return afterThread ? `${MAIN_TAG}\n${text}` : text
}

/**
 * Given to the agent with every session (SPEC → Agent instructions), so it reads the
 * tags above as Gloss means them.
 */
export const AGENT_INSTRUCTIONS = `This session runs in Gloss, a GUI that lets the user reply to individual points of your answers in side threads. You see one conversation; the threads exist only in the UI.

- Every message sent from a thread starts with \`[re: "<quote>"]\`, quoting the point it's about. Answer about that point and don't bring in other topics, open questions or follow-ups from elsewhere in the conversation; the user raises those in the main conversation.
- \`[re: "<quote>", continued in the main conversation]\` replies to that point but moves the discussion back to the main conversation, so answer it in the broader context.
- Messages in the main conversation are untagged, except the first one after a thread, which starts with \`${MAIN_TAG}\`.`
