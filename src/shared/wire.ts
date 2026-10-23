// The wire format for thread messages (SPEC → Wire format).
import type { Anchor, Attachment, Pin } from './types'

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

/**
 * What a thread's tags quote: the anchor text, after the file and lines for diff lines.
 * A pin names itself and quotes its note: `screenshot pin 2 "<note>"`.
 */
function quoted(anchor: Anchor): string {
  if (anchor.kind === 'pin') {
    const name = `screenshot${anchor.screenshot ? ` ${anchor.screenshot}` : ''} pin ${anchor.pin}`
    const note = anchor.note.trim()
    return note ? `${name} "${truncate(note, WIRE_ANCHOR_LENGTH)}"` : name
  }
  const text = `"${truncate(anchor.text, WIRE_ANCHOR_LENGTH)}"`
  if (anchor.kind !== 'line') return text
  const range = anchor.start === anchor.end ? `${anchor.start}` : `${anchor.start}-${anchor.end}`
  return `${anchor.file}:${range}${anchor.side === 'old' ? ' (old)' : ''} ${text}`
}

/** The tag of a thread's messages: `[re: "<text>"]`, `[re: path:line "<text>"]` for diff lines, `[re: screenshot pin 2 "<note>"]` for a pin. */
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

/** How a pin is named in the conversation: "Pin 2: <note>", or "Pin 2" without a note. */
export function pinLabel(n: number, note: string): string {
  const text = note.replace(/\s+/g, ' ').trim()
  return text ? `Pin ${n}: ${text}` : `Pin ${n}`
}

/** The screenshots among a message's attachments that have pins, as [attachment index, pins]. */
export function pinnedImages(attachments: Attachment[]): [number, Pin[]][] {
  const out: [number, Pin[]][] = []
  attachments.forEach((a, i) => {
    if (a.kind === 'image' && a.pins && a.pins.length > 0) out.push([i, a.pins])
  })
  return out
}

/**
 * The pin lists of a message's annotated screenshots (SPEC → Visual feedback), sent after its
 * text: "Screenshot with 2 numbered pins:" and a line per pin, "1: <note>". With several
 * annotated screenshots, each is numbered in the order they are attached: "Screenshot 2 with …".
 */
export function pinList(attachments: Attachment[]): string {
  const pinned = pinnedImages(attachments)
  return pinned
    .map(([, pins], i) => {
      const name = pinned.length > 1 ? `Screenshot ${i + 1}` : 'Screenshot'
      const lines = pins.map((p, n) => `${n + 1}: ${p.note.replace(/\s+/g, ' ').trim() || '(no note)'}`)
      return [`${name} with ${pins.length} numbered pin${pins.length === 1 ? '' : 's'}:`, ...lines].join('\n')
    })
    .join('\n\n')
}

/**
 * A message's wire text with its screenshots' pin lists after it, in the text block the
 * images follow. Kept in the wire text, so a replay of the message matches it.
 */
export function withPins(wire: string, attachments: Attachment[]): string {
  const pins = pinList(attachments)
  if (!pins) return wire
  return wire.trim() ? `${wire}\n\n${pins}` : `${wire}${pins}`
}

/**
 * The anchor of pin `pin` on the screenshot at `image` among a message's attachments, made
 * from the message itself rather than what the renderer sent (SPEC → Visual feedback).
 */
export function pinAnchor(attachments: Attachment[], image: number, pin: number): Anchor {
  const a = attachments[image]
  const p = a?.kind === 'image' && Number.isInteger(pin) && pin >= 1 ? a.pins?.[pin - 1] : undefined
  if (!p) throw new Error('That pin is not on this message.')
  const pinned = pinnedImages(attachments)
  const screenshot = pinned.length > 1 ? pinned.findIndex(([i]) => i === image) + 1 : 0
  return { kind: 'pin', image, pin, ...(screenshot ? { screenshot } : {}), note: p.note, text: pinLabel(pin, p.note) }
}

/**
 * Given to the agent with every session (SPEC → Agent instructions), so it reads the
 * tags above as Gloss means them.
 */
export const AGENT_INSTRUCTIONS = `This session runs in Gloss, a GUI that lets the user reply to individual points of your answers in side threads. You see one conversation; the threads exist only in the UI.

- Every message sent from a thread starts with \`[re: "<quote>"]\`, quoting the point it's about. Answer about that point and don't bring in other topics, open questions or follow-ups from elsewhere in the conversation; the user raises those in the main conversation.
- \`[re: "<quote>", continued in the main conversation]\` replies to that point but moves the discussion back to the main conversation, so answer it in the broader context.
- Messages in the main conversation are untagged, except the first one after a thread, which starts with \`${MAIN_TAG}\`.
- A screenshot can come with numbered pins the user placed on it, listed as \`1: <note>\`. \`[re: screenshot pin 2 "<note>"]\` is a thread about pin 2.`
