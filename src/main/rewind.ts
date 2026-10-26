import type { Attachment } from '../shared/types'

/**
 * Retained context of a conversation rewound by an older Gloss, which started a fresh
 * agent session and sent the transcript with the next prompt. Kept so such a rewind
 * that hasn't been sent yet still is; Gloss no longer makes them.
 */
export type RewindSeed = { text: string; images: Extract<Attachment, { kind: 'image' }>[] }

type Entry = { type: string; uuid?: string; parentUuid?: string | null; isSidechain?: boolean }

/**
 * The transcript entry a fork of a Claude session ends on so that it drops `targetUuid`
 * and everything after it: the nearest user or assistant entry the target follows on its
 * branch. This keeps a cancelled turn's tool result and interrupt marker, and reaches
 * past a compaction (the active history starts at the summary). Null when nothing
 * precedes the target.
 */
export function claudeForkBoundary(entries: Entry[], targetUuid: string): string | null {
  const byUuid = new Map(entries.flatMap((e) => (e.uuid ? [[e.uuid, e] as const] : [])))
  const target = byUuid.get(targetUuid)
  if (!target) throw new Error("Couldn't find that message in the agent's history.")
  const seen = new Set<string>()
  let cursor = target.parentUuid
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const entry = byUuid.get(cursor)
    if (!entry) break
    if ((entry.type === 'user' || entry.type === 'assistant') && entry.isSidechain !== true) return cursor
    cursor = entry.parentUuid
  }
  return null
}

/**
 * Forks a Claude Code session before the user message `targetUuid`, through the Agent SDK
 * the Claude adapter uses for `session/fork`. The adapter takes only agent message ids or
 * active-history entries, which can't name a cancelled turn's last entry or a point
 * before a compaction. Returns the new session's id, or null when nothing would be kept.
 */
export async function forkClaude(acpSessionId: string, cwd: string, targetUuid: string): Promise<string | null> {
  const { forkSession, importSessionToStore } = await import('@anthropic-ai/claude-agent-sdk')
  // Every branch, not just the active one: a compaction leaves the earlier history off it.
  const entries: Entry[] = []
  await importSessionToStore(acpSessionId, {
    append: async (_key, batch) => { entries.push(...(batch as Entry[])) },
    load: async () => null
  }, { dir: cwd, includeSubagents: false })
  const boundary = claudeForkBoundary(entries, targetUuid)
  if (!boundary) return null
  return (await forkSession(acpSessionId, { dir: cwd, upToMessageId: boundary })).sessionId
}
