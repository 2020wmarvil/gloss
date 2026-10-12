import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossEvent, Settings } from '@shared/ipc'
import type { AgentInfo, AuthMethodInfo, Message, Session, ToolCall } from '@shared/types'
import { Conversation, type Notice } from './Conversation'
import { Sidebar } from './Sidebar'
import { SignInDialog } from './SignInDialog'

export type OpenSession = {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
}

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

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [open, setOpen] = useState<OpenSession | null>(null)
  /** sessionId → threadId of its running turn. */
  const [running, setRunning] = useState<Record<string, string | null>>({})
  const [notices, setNotices] = useState<Record<string, Notice[]>>({})
  const [signIn, setSignIn] = useState<SignInRequest | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const openId = useRef<string | null>(null)
  const lastSeq = useRef(-1)

  const addNotice = useCallback((sessionId: string, text: string) => {
    setNotices((all) => ({
      ...all,
      [sessionId]: [
        ...(all[sessionId] ?? []),
        { id: crypto.randomUUID(), text, afterSeq: openId.current === sessionId ? lastSeq.current : Infinity }
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
        case 'turnStart':
          setRunning((r) => ({ ...r, [event.sessionId]: event.threadId }))
          break
        case 'turnEnd':
          setRunning((r) => {
            const next = { ...r }
            delete next[event.sessionId]
            return next
          })
          if (event.error) addNotice(event.sessionId, `The turn failed: ${event.error}`)
          else if (event.stopReason === 'cancelled') addNotice(event.sessionId, 'Cancelled.')
          else if (event.stopReason && event.stopReason !== 'end_turn')
            addNotice(event.sessionId, `The agent stopped: ${event.stopReason.replace(/_/g, ' ')}.`)
          break
        case 'notice':
          addNotice(event.sessionId, event.text)
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
    openId.current = id
    const view = await window.gloss.sessions.open(id)
    if (openId.current !== id) return
    lastSeq.current = Math.max(
      -1,
      ...view.messages.map((m) => m.seq),
      ...view.toolCalls.map((t) => t.messageSeq)
    )
    setOpen({ session: view.session, messages: view.messages, toolCalls: view.toolCalls })
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

  async function send(text: string): Promise<void> {
    if (!open) return
    // Errors arrive as turnEnd events.
    await window.gloss.send(open.session.id, text, null).catch((err: unknown) => {
      addNotice(open.session.id, errorText(err))
    })
  }

  async function toggleDevModel(on: boolean): Promise<void> {
    setSettings(await window.gloss.settings.setDevModel(on))
  }

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        openId={open?.session.id ?? null}
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
          running={open.session.id in running}
          notices={notices[open.session.id] ?? []}
          onSend={(text) => void send(text)}
          onCancel={() => void window.gloss.cancel(open.session.id)}
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
