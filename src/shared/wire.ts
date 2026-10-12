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

/** What is sent to the agent: main-thread messages unchanged, thread messages tagged. */
export function wireText(text: string, anchorText: string | null): string {
  return anchorText === null ? text : `${wireTag(anchorText)}\n${text}`
}
