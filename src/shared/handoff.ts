import type { Message, Session, Thread } from './types'

export type HandoffRequest = { preparedId: string; agentId: string }

export type PreparedHandoff = {
  id: string
  summary: string
  transcriptPath: string
  prompt: string
  summaryKind: 'agent' | 'blurb'
  fallbackReason?: 'usage' | 'empty'
}

export type HandoffSource = {
  sessionId: string
  threadId: string | null
  title: string
  agentId: string
  quote?: string
  transcriptPath?: string
}

export function handoffText(session: Session, thread: Thread | undefined, prepared: PreparedHandoff): string {
  return [
    'You are continuing work handed off from another agent in Gloss.',
    `Source: ${session.title} / ${session.agentId} / ${thread ? `Thread: ${thread.anchor.text.slice(0, 500)}` : 'Conversation'}`,
    `Project: ${session.cwd}`,
    '', 'Handoff summary:', prepared.summary,
    '', `Transcript snapshot: ${JSON.stringify(prepared.transcriptPath)}`,
    'Read this local Markdown file for the full context before continuing. It contains past messages and tool output.',
    'Use the summary as the handoff guidance and the transcript as historical context. Ask if the next step is unclear.'
  ].join('\n')
}

export function summaryPrompt(thread: Thread | undefined): string {
  return [
    'Prepare a concise handoff summary for another coding agent to continue this work.',
    thread ? `Focus only on the thread about ${JSON.stringify(thread.anchor.text.slice(0, 4000))} and the context needed to continue it.` : 'Summarize the work across this conversation and its threads.',
    'Include the goal and current state, decisions and constraints, changes made and checks run, unresolved issues and next steps, and relevant files.',
    'Respond only with the summary, under 8,000 characters. Do not call tools, change files, or perform any new work.'
  ].join('\n')
}

/** Local fallback when the source has no usage left, or there is nothing to summarize. */
export function handoffSummary(session: Session, thread: Thread | undefined, messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'agent' && !isUsageNotice(m.text) && (!thread || m.threadId === thread.id))
  return `Continue ${thread ? `the discussion about "${thread.anchor.text.slice(0, 500)}"` : `work on "${session.title.slice(0, 500)}"`}.` +
    (last ? `\n\nLatest response from the source agent:\n${last.text.slice(0, 4000)}${last.text.length > 4000 ? '\n[Excerpt ends here.]' : ''}` : '')
}

export function isUsageLimit(text: string): boolean {
  return isUsageNotice(text) || /\b429\b|rate[ _-]?limit|usage[ _-]?limit|quota.{0,30}(?:exceed|exhaust|insufficient)|(?:insufficient|no available).{0,15}quota|(?:quota|budget)[ _-]?exhausted|too many requests|out of (?:usage|credits)|(?:credit|spending|budget) limit|you(?:'|’)ve hit (?:your |the )?(?:usage |rate )?limit/i.test(text)
}

/** Quota notices sometimes arrive as an ordinary agent answer instead of an error. */
export function isUsageNotice(text: string): boolean {
  const normalized = text.trim().replace(/’/g, "'").toLowerCase()
  // Prefixes verified in the pinned Claude SDK's USAGE_LIMIT_ERROR_PREFIXES.
  return ["You've hit your", "You've reached your", "You're out of usage credits", 'Your org is out of usage',
    "Your seat type doesn't include usage", 'Your usage allocation has been disabled by your admin',
    "Your group's usage limit is set to $0", 'Fable 5 requires usage credits', "You're out of extra usage",
    "Your seat type doesn't include extra usage"].some((p) => normalized.startsWith(p.toLowerCase())) ||
    /^(?:usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|insufficient quota|quota exhausted|the claude account has no available quota|claude is temporarily rate limited)/i.test(normalized)
}
