// The wire format for thread messages (SPEC → Wire format).

export const WIRE_ANCHOR_LENGTH = 80

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The tag that prefixes a thread message so the agent knows what it refers to. */
export function wireTag(anchorText: string): string {
  return `[re: "${truncate(anchorText, WIRE_ANCHOR_LENGTH)}"]`
}

/** The tag on the first main-thread message after a thread, so the agent knows the thread is over. */
export const MAIN_TAG = '[main]'

/**
 * What is sent to the agent: thread messages tagged with their anchor, main-thread
 * messages unchanged unless they follow a thread (`afterThread`).
 */
export function wireText(text: string, anchorText: string | null, afterThread = false): string {
  if (anchorText !== null) return `${wireTag(anchorText)}\n${text}`
  return afterThread ? `${MAIN_TAG}\n${text}` : text
}
