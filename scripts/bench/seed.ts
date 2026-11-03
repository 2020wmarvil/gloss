// Seeds a scratch Gloss user data folder for the benchmark (M25): large sessions with
// long code-heavy answers, tool calls, diffs, threads and screenshots, through the real
// Store. Also writes each session's ACP history, which the fake agent replays on load,
// so opening a session finds nothing to change.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../../src/main/db'
import type { Anchor, Attachment, Message, Thread, ToolCall } from '../../src/shared/types'
import { withPins, wireText } from '../../src/shared/wire'
// @ts-expect-error A plain ES module shared with the fake agent.
import { answer, random, screenshot, SCREENSHOT_SIZES, toolCall, uniquePng, userText } from './content.mjs'

export type SessionSpec = {
  title: string
  turns: number
  /** Every this many turns a user message carries screenshots; 0 for none. */
  imageEvery: number
  threads: number
  answerChars: [number, number]
}

/** The sessions the benchmark seeds: the first opens at startup. */
export const SESSIONS: SessionSpec[] = [
  { title: 'Bench: image-heavy redesign', turns: 300, imageEvery: 4, threads: 40, answerChars: [1500, 6000] },
  { title: 'Bench: code-heavy migration', turns: 300, imageEvery: 0, threads: 30, answerChars: [3000, 9000] },
  ...[1, 2, 3].map((n) => ({ title: `Bench: medium session ${n}`, turns: 80, imageEvery: 10, threads: 8, answerChars: [1000, 4000] as [number, number] })),
  ...Array.from({ length: 25 }, (_, n) => ({ title: `Bench: small session ${n + 1}`, turns: 3 + (n % 6), imageEvery: 0, threads: n % 3, answerChars: [400, 1500] as [number, number] }))
]

type Update = Record<string, unknown>

export function seed(dataDir: string, project: string, agentId: string): { sessions: { id: string; acpSessionId: string; title: string; messages: number; toolCalls: number; threads: number; images: number }[] } {
  mkdirSync(join(dataDir, 'bench-agent'), { recursive: true })
  const store = new Store(join(dataDir, 'gloss.db'))
  store.addProject(project, Date.now() - 86_400_000)
  const shots = SCREENSHOT_SIZES.map(([w, h]: [number, number], i: number) => screenshot(1000 + i, w, h))
  const summary = []
  // Newest last, so the first spec has the most recent activity and opens at startup.
  const start = Date.now() - 3_600_000
  for (let s = SESSIONS.length - 1; s >= 0; s--) {
    const spec = SESSIONS[s]
    const r = random(s + 1)
    const id = `bench-session-${s}`
    const acpSessionId = `bench-acp-${s}`
    const at = start + (SESSIONS.length - s) * 60_000
    store.insertSession({ id, agentId, acpSessionId, cwd: project, title: spec.title, titleSet: true, createdAt: at - 86_400_000, activeAt: at })
    const replay: Update[] = []
    let seq = 0
    let images = 0
    let tools = 0
    let messages = 0
    const anchors: { messageId: string; anchor: Anchor }[] = []
    const message = (m: Omit<Message, 'sessionId' | 'seq' | 'createdAt'>, time: number): Message => {
      const full: Message = { ...m, sessionId: id, seq: seq++, createdAt: time }
      store.insertMessage(full)
      messages++
      return full
    }
    const user = (text: string, threadId: string | null, wire: string, attachments: Attachment[] | undefined, time: number): void => {
      const full = withPins(wire, attachments ?? [])
      message({ id: `${id}-m${seq}`, role: 'user', text, wireText: full, threadId, ...(attachments ? { attachments } : {}) }, time)
      replay.push({ sessionUpdate: 'user_message_chunk', messageId: `${id}-m${seq - 1}`, content: { type: 'text', text: full } })
      for (const a of attachments ?? []) if (a.kind === 'image') replay.push({ sessionUpdate: 'user_message_chunk', messageId: `${id}-m${seq - 1}`, content: { type: 'image', mimeType: a.mimeType, data: a.data } })
    }
    const agent = (text: string, threadId: string | null, time: number): Message => {
      const acpMessageId = `${id}-a${seq}`
      const m = message({ id: `${id}-m${seq}`, role: 'agent', text, threadId, acpMessageId }, time)
      replay.push({ sessionUpdate: 'agent_message_chunk', messageId: acpMessageId, content: { type: 'text', text } })
      return m
    }
    const tool = (threadId: string | null): void => {
      const t = toolCall(r, `${id}-t${seq}`)
      const row: ToolCall = { id: t.toolCallId, sessionId: id, messageSeq: seq++, threadId, title: t.title, kind: t.kind, status: t.status, content: t.content }
      store.upsertToolCall(row)
      replay.push({ sessionUpdate: 'tool_call', ...t })
      tools++
    }
    const threadAt = new Set(Array.from({ length: spec.threads }, (_, i) => Math.floor(((i + 0.5) * spec.turns) / Math.max(1, spec.threads))))
    let afterThread = false
    for (let turn = 0; turn < spec.turns; turn++) {
      const time = at - (spec.turns - turn) * 90_000
      let attachments: Attachment[] | undefined
      if (spec.imageEvery && turn % spec.imageEvery === spec.imageEvery - 1) {
        attachments = Array.from({ length: r.int(1, 3) }, (): Attachment => {
          const shot = r.int(0, shots.length - 1)
          const [w, h] = SCREENSHOT_SIZES[shot]
          const pins = r.next() < 0.6 ? Array.from({ length: r.int(1, 5) }, () => ({ x: r.int(20, w - 20), y: r.int(20, h - 20), note: userText(r).slice(0, 80) })) : undefined
          images++
          return { kind: 'image', name: 'screenshot.png', mimeType: 'image/png', data: uniquePng(shots[shot], `${id}-${images}`).toString('base64'), ...(pins ? { pins } : {}) }
        })
      }
      const text = userText(r)
      user(text, null, wireText(text, null, afterThread), attachments, time)
      afterThread = false
      agent(answer(r, 200), null, time + 1000)
      for (let i = r.int(1, 5); i > 0; i--) tool(null)
      const final = agent(answer(r, r.int(...spec.answerChars)), null, time + 20_000)
      if (threadAt.has(turn)) {
        // A thread on a selection in one of the answer's paragraphs, as the user would start one.
        const paragraph = final.text.split('\n\n').find((p) => /^[A-Z]/.test(p) && !p.includes('`'))
        if (!paragraph) continue
        const start = final.text.indexOf(paragraph) + paragraph.indexOf(' ') + 1
        const end = start + Math.min(60, paragraph.length - paragraph.indexOf(' ') - 2)
        const anchor: Anchor = { kind: 'selection', start, end, text: final.text.slice(start, end) }
        const threadId = `${id}-thread${anchors.length}`
        const thread: Thread = { id: threadId, sessionId: id, anchorMessageId: final.id, anchor, createdAt: time + 30_000 }
        store.insertThread(thread)
        anchors.push({ messageId: final.id, anchor })
        for (let k = r.int(1, 3); k > 0; k--) {
          const reply = userText(r)
          user(reply, threadId, wireText(reply, anchor), undefined, time + 40_000)
          if (r.next() < 0.4) tool(threadId)
          agent(answer(r, r.int(400, 2000)), threadId, time + 50_000)
        }
        afterThread = true
      }
    }
    writeFileSync(join(dataDir, 'bench-agent', `${acpSessionId}.json`), JSON.stringify({ cwd: project, updates: replay }))
    summary.unshift({ id, acpSessionId, title: spec.title, messages, toolCalls: tools, threads: anchors.length, images })
  }
  store.close()
  return { sessions: summary }
}


// Run as a script (bundled by run.mjs): seed <data folder> <project folder> <agent id>
const [dataDir, project, agentId] = process.argv.slice(2)
if (dataDir && project && agentId) {
  const result = seed(dataDir, project, agentId)
  process.stdout.write(JSON.stringify(result) + '\n')
}
