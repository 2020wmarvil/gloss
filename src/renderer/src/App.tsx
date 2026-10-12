import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossEvent, Settings } from '@shared/ipc'
import type { AgentInfo, Anchor, AuthMethodInfo, Message, Session, Thread, ToolCall } from '@shared/types'
import { truncate } from '@shared/wire'
import { itemLabel, listItemSpans, type ListItemSpan } from './anchors'
import { Conversation } from './Conversation'
import type { Notice } from './Log'
import { Sidebar } from './Sidebar'
import type { SourceSelection } from './SelectionPopover'
import { SignInDialog } from './SignInDialog'
import { ThreadPanel } from './ThreadPanel'

export type OpenSession = {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
  threads: Thread[]
}

/** The open thread panel. threadId is null until the first message creates the thread. */
export type Panel = { anchorMessageId: string; anchor: Anchor; threadId: string | null }

export type SignInRequest = { agentId: string; agentName: string; methods: AuthMethodInfo[] }

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in IPC handlers.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** A short name for an anchor: "item 2", or the quoted start of a selection. */
function anchorLabel(open: OpenSession, anchorMessageId: string, anchor: Anchor): string {
  if (anchor.kind === 'listItem') {
    const message = open.messages.find((m) => m.id === anchorMessageId)
    const span = message ? listItemSpans(message.text)[anchor.path[0]] : undefined
    return `item ${message && span ? itemLabel(message.text, span) : anchor.path[0] + 1}`
  }
  return `“${truncate(anchor.text, 32)}”`
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [open, setOpen] = useState<OpenSession | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  /** sessionId → threadId of its running turn. */
  const [running, setRunning] = useState<Record<string, string | null>>({})
  const [notices, setNotices] = useState<Record<string, Notice[]>>({})
  const [signIn, setSignIn] = useState<SignInRequest | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const openId = useRef<string | null>(null)
  const lastSeq = useRef(-1)

  const addNotice = useCallback((sessionId: string, threadId: string | null, text: string) => {
    setNotices((all) => ({
      ...all,
      [sessionId]: [
        ...(all[sessionId] ?? []),
        {
          id: crypto.randomUUID(),
          threadId,
          text,
          afterSeq: openId.current === sessionId ? lastSeq.current : Infinity
        }
      ]
    }))
  }, [])

  const onEvent = useCallback(
    (event: GlossEvent) => {
      switch (event.type) {
        case 'session':
          setSessions((list) =>
            upsert(list, event.session).sort((a, b) => b.createdAt - a.createdAt)
          )
          setOpen((o) => (o && o.session.id === event.session.id ? { ...o, session: event.session } : o))
          break
        case 'message':
          if (event.message.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.message.seq)
          setOpen((o) => (o ? { ...o, messages: upsert(o.messages, event.message) } : o))
          break
        case 'toolCall':
          if (event.toolCall.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.toolCall.messageSeq)
          setOpen((o) => (o ? { ...o, toolCalls: upsert(o.toolCalls, event.toolCall) } : o))
          break
        case 'thread':
          if (event.thread.sessionId !== openId.current) break
          setOpen((o) => (o ? { ...o, threads: upsert(o.threads, event.thread) } : o))
          break
        case 'turnStart':
          setRunning((r) => ({ ...r, [event.sessionId]: event.threadId }))
          break
        case 'turnEnd':
          setRunning((r) => {
            const next = { ...r }
            delete next[event.sessionId]
            return next
          })
          if (event.error) addNotice(event.sessionId, event.threadId, `The turn failed: ${event.error}`)
          else if (event.stopReason === 'cancelled') addNotice(event.sessionId, event.threadId, 'Cancelled.')
          else if (event.stopReason && event.stopReason !== 'end_turn')
            addNotice(event.sessionId, event.threadId, `The agent stopped: ${event.stopReason.replace(/_/g, ' ')}.`)
          break
        case 'notice':
          addNotice(event.sessionId, event.threadId, event.text)
          break
        case 'authRequired':
          setSignIn({ agentId: event.agentId, agentName: event.agentName, methods: event.methods })
          break
        case 'authResolved':
          setSignIn((s) => (s?.agentId === event.agentId ? null : s))
          break
      }
    },
    [addNotice]
  )

  useEffect(() => window.gloss.onEvent(onEvent), [onEvent])

  useEffect(() => {
    void window.gloss.settings.get().then(setSettings)
    void window.gloss.agents.list().then(setAgents)
    void window.gloss.sessions.list().then((list) => {
      setSessions(list)
      if (list[0]) void selectSession(list[0].id)
    })
  }, [])

  async function selectSession(id: string): Promise<void> {
    if (openId.current !== id) setPanel(null)
    openId.current = id
    const view = await window.gloss.sessions.open(id)
    if (openId.current !== id) return
    lastSeq.current = Math.max(
      -1,
      ...view.messages.map((m) => m.seq),
      ...view.toolCalls.map((t) => t.messageSeq)
    )
    setOpen({
      session: view.session,
      messages: view.messages,
      toolCalls: view.toolCalls,
      threads: view.threads
    })
    setRunning((r) => {
      const next = { ...r }
      if (view.turn) next[id] = view.turn.threadId
      else delete next[id]
      return next
    })
  }

  async function newSession(): Promise<void> {
    setCreateError(null)
    const cwd = await window.gloss.dialog.pickDirectory()
    const agent = agents[0]
    if (!cwd || !agent) return
    setCreating(true)
    try {
      const session = await window.gloss.sessions.create(cwd, agent.id)
      await selectSession(session.id)
    } catch (err) {
      setCreateError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  function openItem(message: Message, span: ListItemSpan): void {
    if (!open) return
    const existing = open.threads.find(
      (t) =>
        t.anchorMessageId === message.id &&
        t.anchor.kind === 'listItem' &&
        t.anchor.path.length === 1 &&
        t.anchor.path[0] === span.index
    )
    setPanel(
      existing
        ? { anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id }
        : {
            anchorMessageId: message.id,
            anchor: { kind: 'listItem', path: [span.index], text: span.text },
            threadId: null
          }
    )
  }

  function openSelection(message: Message, selection: SourceSelection): void {
    if (!open) return
    const existing = open.threads.find(
      (t) =>
        t.anchorMessageId === message.id &&
        t.anchor.kind === 'selection' &&
        t.anchor.start === selection.start &&
        t.anchor.end === selection.end
    )
    setPanel(
      existing
        ? { anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id }
        : { anchorMessageId: message.id, anchor: { kind: 'selection', ...selection }, threadId: null }
    )
  }

  function openThread(threadId: string): void {
    const t = open?.threads.find((x) => x.id === threadId)
    if (t) setPanel({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
  }

  async function send(text: string, target: Panel | null): Promise<void> {
    if (!open) return
    const sessionId = open.session.id
    let threadId: string | null = null
    try {
      if (target) {
        threadId = target.threadId
        if (threadId === null) {
          // The thread is created by its first message (SPEC → Data model).
          const thread = await window.gloss.threads.create(sessionId, target.anchorMessageId, target.anchor)
          threadId = thread.id
          setOpen((o) => (o && o.session.id === sessionId ? { ...o, threads: upsert(o.threads, thread) } : o))
          setPanel((p) => (p === target ? { ...target, threadId: thread.id } : p))
        }
      }
      // Turn errors arrive as turnEnd events.
      await window.gloss.send(sessionId, text, threadId)
    } catch (err) {
      addNotice(sessionId, threadId, errorText(err))
    }
  }

  async function toggleDevModel(on: boolean): Promise<void> {
    setSettings(await window.gloss.settings.setDevModel(on))
  }

  const sessionId = open?.session.id
  const runningThread = sessionId !== undefined && sessionId in running ? running[sessionId] : undefined
  const runningThreadRow = open?.threads.find((t) => t.id === runningThread)
  const sessionNotices = sessionId ? (notices[sessionId] ?? []) : []

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        openId={sessionId ?? null}
        running={running}
        creating={creating}
        createError={createError}
        settings={settings}
        onSelect={(id) => void selectSession(id)}
        onNew={() => void newSession()}
        onToggleDevModel={(on) => void toggleDevModel(on)}
      />
      {open ? (
        <Conversation
          key={open.session.id}
          open={open}
          agentName={agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId}
          runningThread={runningThread}
          runningLabel={
            runningThreadRow ? anchorLabel(open, runningThreadRow.anchorMessageId, runningThreadRow.anchor) : null
          }
          notices={sessionNotices}
          panel={panel}
          onSend={(text) => void send(text, null)}
          onCancel={() => void window.gloss.cancel(open.session.id)}
          onOpenItem={openItem}
          onOpenSelection={openSelection}
          onOpenThread={openThread}
        />
      ) : (
        <main className="empty-state">
          <p>{creating ? 'Starting the agent…' : 'Start a session to talk to an agent in a project folder.'}</p>
          {!creating && (
            <button className="primary" onClick={() => void newSession()} disabled={agents.length === 0}>
              New session
            </button>
          )}
        </main>
      )}
      {open && panel && (
        <ThreadPanel
          open={open}
          panel={panel}
          label={
            panel.anchor.kind === 'selection'
              ? panel.threadId === null
                ? 'from selection'
                : 'selection'
              : anchorLabel(open, panel.anchorMessageId, panel.anchor)
          }
          runningThread={runningThread}
          notices={sessionNotices}
          onSend={(text) => void send(text, panel)}
          onCancel={() => void window.gloss.cancel(open.session.id)}
          onClose={() => setPanel(null)}
        />
      )}
      {signIn && (
        <SignInDialog
          request={signIn}
          onSignIn={(methodId) => window.gloss.auth.signIn(signIn.agentId, methodId)}
          onDismiss={() => void window.gloss.auth.dismiss(signIn.agentId)}
        />
      )}
    </div>
  )
}
