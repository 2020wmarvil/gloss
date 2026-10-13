import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, GlossEvent, SettingsPatch, SettingsState } from '@shared/ipc'
import { sameFolder } from '@shared/paths'
import type {
  AgentInfo,
  AgentSession,
  Anchor,
  Attachment,
  AuthMethodInfo,
  Message,
  Project,
  Session,
  SessionLive,
  Thread,
  ToolCall
} from '@shared/types'
import { truncate } from '@shared/wire'
import { itemLabel, listItemSpans, type ListItemSpan } from './anchors'
import { FOCUS_COMPOSER } from './Composer'
import { errorText } from './errors'
import { Conversation } from './Conversation'
import type { Notice } from './Log'
import { Sidebar } from './Sidebar'
import type { SourceSelection } from './SelectionPopover'
import { SettingsScreen } from './SettingsScreen'
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

const NO_LIVE: SessionLive = {
  attached: false,
  model: null,
  commands: [],
  usage: null,
  rateLimits: [],
  permissions: null,
  accepts: { image: false, file: false }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
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
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  /** Project path → the agent's sessions there not yet in Gloss. */
  const [agentSessions, setAgentSessions] = useState<Record<string, AgentSession[]>>({})
  const [agentSessionsError, setAgentSessionsError] = useState<string | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [open, setOpen] = useState<OpenSession | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  /** sessionId → threadId of its running turn. */
  const [running, setRunning] = useState<Record<string, string | null>>({})
  const [notices, setNotices] = useState<Record<string, Notice[]>>({})
  const [lives, setLives] = useState<Record<string, SessionLive>>({})
  const [git, setGit] = useState<GitStatus | null>(null)
  const [signIn, setSignIn] = useState<SignInRequest | null>(null)
  const [creating, setCreating] = useState(false)
  const [sidebarError, setSidebarError] = useState<string | null>(null)

  const openId = useRef<string | null>(null)
  /** The open session's folder, for refreshing its git status. */
  const openCwd = useRef<string | null>(null)
  const lastSeq = useRef(-1)
  const project = projects.find((p) => projectPath !== null && sameFolder(p.path, projectPath)) ?? null
  const agent = agents[0]

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

  const refreshGit = useCallback((cwd: string, sessionId: string) => {
    void window.gloss.git.status(cwd).then((status) => {
      if (openId.current === sessionId) setGit(status)
    })
  }, [])

  const refreshProjects = useCallback(async () => setProjects(await window.gloss.projects.list()), [])

  const loadAgentSessions = useCallback(
    async (path: string) => {
      if (!agent) return
      setAgentSessionsError(null)
      try {
        const list = await window.gloss.projects.agentSessions(path, agent.id)
        setAgentSessions((all) => ({ ...all, [path]: list }))
      } catch (err) {
        setAgentSessionsError(`Couldn't list the agent's sessions: ${errorText(err)}`)
        setAgentSessions((all) => ({ ...all, [path]: [] }))
      }
    },
    [agent]
  )

  const selectSession = useCallback(
    async (id: string, threadId: string | null = null): Promise<void> => {
      setShowSettings(false)
      if (openId.current !== id) {
        setPanel(null)
        setGit(null)
      }
      openId.current = id
      const view = await window.gloss.sessions.open(id)
      if (openId.current !== id) return
      lastSeq.current = Math.max(-1, ...view.messages.map((m) => m.seq), ...view.toolCalls.map((t) => t.messageSeq))
      setOpen({ session: view.session, messages: view.messages, toolCalls: view.toolCalls, threads: view.threads })
      openCwd.current = view.session.cwd
      setProjectPath(view.session.cwd)
      setLives((l) => ({ ...l, [id]: view.live }))
      setRunning((r) => {
        const next = { ...r }
        if (view.turn) next[id] = view.turn.threadId
        else delete next[id]
        return next
      })
      refreshGit(view.session.cwd, id)
      const thread = threadId ? view.threads.find((t) => t.id === threadId) : undefined
      if (thread) setPanel({ anchorMessageId: thread.anchorMessageId, anchor: thread.anchor, threadId: thread.id })
    },
    [refreshGit]
  )

  /** Shows a project: its most recent session, or none. */
  const selectProject = useCallback(
    (path: string, all: Session[]) => {
      setProjectPath(path)
      const first = all.find((s) => sameFolder(s.cwd, path))
      if (first) {
        if (first.id !== openId.current) void selectSession(first.id)
      } else {
        openId.current = null
        setOpen(null)
        setPanel(null)
      }
    },
    [selectSession]
  )

  const onEvent = useCallback(
    (event: GlossEvent) => {
      switch (event.type) {
        case 'session':
          setSessions((list) => upsert(list, event.session).sort((a, b) => b.createdAt - a.createdAt))
          setOpen((o) => (o && o.session.id === event.session.id ? { ...o, session: event.session } : o))
          break
        case 'sessionDeleted':
          setSessions((list) => list.filter((s) => s.id !== event.sessionId))
          if (openId.current === event.sessionId) {
            openId.current = null
            setOpen(null)
            setPanel(null)
          }
          break
        case 'live':
          setLives((l) => ({ ...l, [event.sessionId]: event.live }))
          break
        case 'reveal':
          void selectSession(event.sessionId, event.threadId)
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
          // The agent may have changed files: refresh the branch's dirty marker.
          if (event.sessionId === openId.current && openCwd.current) refreshGit(openCwd.current, event.sessionId)
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
        case 'settings':
          setSettings(event.state)
          break
      }
    },
    [addNotice, refreshGit, selectSession]
  )

  useEffect(() => window.gloss.onEvent(onEvent), [onEvent])

  useEffect(() => {
    void window.gloss.settings.get().then(setSettings)
    void window.gloss.agents.list().then(setAgents)
    void Promise.all([window.gloss.projects.list(), window.gloss.sessions.list()]).then(([ps, list]) => {
      setProjects(ps)
      setSessions(list)
      if (list[0]) void selectSession(list[0].id)
      else if (ps[0]) setProjectPath(ps[0].path)
    })
  }, [selectSession])

  // The agent's sessions for the shown project, listed when it is shown.
  useEffect(() => {
    if (projectPath) void loadAgentSessions(projectPath)
  }, [projectPath, loadAgentSessions])

  async function newSession(): Promise<void> {
    if (!projectPath) return openProject()
    if (!agent) return
    setSidebarError(null)
    setCreating(true)
    try {
      const session = await window.gloss.sessions.create(projectPath, agent.id)
      await selectSession(session.id)
      void refreshProjects()
    } catch (err) {
      setSidebarError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  async function openProject(): Promise<void> {
    setSidebarError(null)
    const p = await window.gloss.projects.open()
    if (!p) return
    await refreshProjects()
    selectProject(p.path, sessions)
  }

  async function importSession(a: AgentSession): Promise<void> {
    if (!projectPath || !agent) return
    setSidebarError(null)
    setImporting(a.acpSessionId)
    try {
      const session = await window.gloss.sessions.import(projectPath, agent.id, a.acpSessionId, a.title)
      setAgentSessions((all) => ({
        ...all,
        [projectPath]: (all[projectPath] ?? []).filter((x) => x.acpSessionId !== a.acpSessionId)
      }))
      await selectSession(session.id)
    } catch (err) {
      setSidebarError(`Couldn't open that session: ${errorText(err)}`)
    } finally {
      setImporting(null)
    }
  }

  async function deleteSession(id: string): Promise<void> {
    setSidebarError(null)
    const deleted = sessions.find((s) => s.id === id)
    try {
      const warning = await window.gloss.sessions.delete(id)
      if (warning) setSidebarError(warning)
      // Show the next session in the project, if the deleted one was open.
      if (deleted && openId.current === null) {
        const rest = sessions.filter((s) => s.id !== id)
        selectProject(deleted.cwd, rest)
      }
    } catch (err) {
      setSidebarError(errorText(err))
    }
  }

  async function deleteProject(path: string): Promise<void> {
    setSidebarError(null)
    try {
      const warning = await window.gloss.projects.delete(path)
      if (warning) setSidebarError(warning)
      const [ps, list] = await Promise.all([window.gloss.projects.list(), window.gloss.sessions.list()])
      setProjects(ps)
      setSessions(list)
      setAgentSessions((all) => {
        const next = { ...all }
        delete next[path]
        return next
      })
      // Show the next project, or nothing.
      if (ps[0]) selectProject(ps[0].path, list)
      else {
        setProjectPath(null)
        openId.current = null
        setOpen(null)
        setPanel(null)
      }
    } catch (err) {
      setSidebarError(errorText(err))
    }
  }

  function exportMarkdown(id: string, threadId: string | null, how: 'copy' | 'save'): void {
    const done =
      how === 'copy' ? window.gloss.sessions.copyMarkdown(id, threadId) : window.gloss.sessions.saveMarkdown(id, threadId)
    done.catch((err: unknown) => addNotice(id, threadId, `Couldn't export: ${errorText(err)}`))
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

  async function send(text: string, attachments: Attachment[], target: Panel | null): Promise<void> {
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
      await window.gloss.send(sessionId, text, threadId, attachments)
    } catch (err) {
      addNotice(sessionId, threadId, errorText(err))
    }
  }

  async function updateSettings(patch: SettingsPatch): Promise<void> {
    setSettings(await window.gloss.settings.update(patch))
  }

  // Keyboard shortcuts (SPEC → Keyboard shortcuts). Esc closes panels in their own components.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcuts.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.key === ',') {
      e.preventDefault()
      setShowSettings((on) => !on)
    } else if (e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void newSession()
    } else if (e.key.toLowerCase() === 'l' && !e.shiftKey) {
      e.preventDefault()
      setShowSettings(false)
      window.dispatchEvent(new Event(FOCUS_COMPOSER))
    } else if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const list = projectPath ? sessions.filter((s) => sameFolder(s.cwd, projectPath)) : sessions
      if (list.length === 0) return
      const back = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey)
      const i = list.findIndex((s) => s.id === openId.current)
      const next = list[(i === -1 ? 0 : i + (back ? list.length - 1 : 1)) % list.length]
      void selectSession(next.id)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => shortcuts.current(e)
    // Files dropped outside the composer must not navigate the window.
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const closeSettings = useCallback(() => setShowSettings(false), [])

  const sessionId = open?.session.id
  const runningThread = sessionId !== undefined && sessionId in running ? running[sessionId] : undefined
  const runningThreadRow = open?.threads.find((t) => t.id === runningThread)
  const sessionNotices = sessionId ? (notices[sessionId] ?? []) : []
  const live = (sessionId && lives[sessionId]) || NO_LIVE
  const devModel = settings?.global.devModel ?? false

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        project={project}
        sessions={sessions}
        openId={sessionId ?? null}
        running={running}
        agentSessions={projectPath ? (agentSessions[projectPath] ?? null) : []}
        agentSessionsError={agentSessionsError}
        importing={importing}
        creating={creating}
        createError={sidebarError}
        settingsOpen={showSettings}
        settingsError={settings?.error != null}
        onSelectProject={(path) => selectProject(path, sessions)}
        onOpenProject={() => void openProject()}
        onDeleteProject={(path) => void deleteProject(path)}
        onSelect={(id) => void selectSession(id)}
        onNew={() => void newSession()}
        onImport={(a) => void importSession(a)}
        onRename={(id, title) =>
          void window.gloss.sessions.rename(id, title).catch((err: unknown) => setSidebarError(errorText(err)))
        }
        onDelete={(id) => void deleteSession(id)}
        onCopyMarkdown={(id) => exportMarkdown(id, null, 'copy')}
        onSaveMarkdown={(id) => exportMarkdown(id, null, 'save')}
        onSettings={() => setShowSettings((on) => !on)}
      />
      {showSettings && settings ? (
        <SettingsScreen
          state={settings}
          projectPath={projectPath}
          onUpdate={updateSettings}
          onOpenFile={() => window.gloss.settings.openFile()}
          onClose={closeSettings}
        />
      ) : open ? (
        <Conversation
          key={open.session.id}
          open={open}
          agentName={agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId}
          live={live}
          git={git}
          devModel={devModel}
          runningThread={runningThread}
          runningLabel={
            runningThreadRow ? anchorLabel(open, runningThreadRow.anchorMessageId, runningThreadRow.anchor) : null
          }
          notices={sessionNotices}
          panel={panel}
          onSend={(text, attachments) => void send(text, attachments, null)}
          onCancel={() => void window.gloss.cancel(open.session.id)}
          onSetModel={(value) => window.gloss.sessions.setModel(open.session.id, value)}
          onOpenItem={openItem}
          onOpenSelection={openSelection}
          onOpenThread={openThread}
        />
      ) : (
        <main className="empty-state">
          {project ? (
            <>
              <p>{creating ? 'Starting the agent…' : `No session open in ${project.name}.`}</p>
              {!creating && (
                <button className="primary" onClick={() => void newSession()} disabled={!agent}>
                  New session
                </button>
              )}
              {!creating && <p className="muted">Or open one of the agent&apos;s sessions from the sidebar.</p>}
            </>
          ) : (
            <>
              <p>Open a project folder to start talking to an agent there.</p>
              <button className="primary" onClick={() => void openProject()}>
                Open project…
              </button>
            </>
          )}
        </main>
      )}
      {open && panel && !showSettings && (
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
          live={live}
          onSend={(text, attachments) => void send(text, attachments, panel)}
          onCancel={() => void window.gloss.cancel(open.session.id)}
          onClose={() => setPanel(null)}
          onCopyMarkdown={(threadId) => exportMarkdown(open.session.id, threadId, 'copy')}
          onSaveMarkdown={(threadId) => exportMarkdown(open.session.id, threadId, 'save')}
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
