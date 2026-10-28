// The phone's view of the desktop (SPEC → Remote and mobile): the lists, what runs or waits where,
// and the open session, kept current from the bridge's events. Everything reloads on reconnect.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossEvent, SessionView } from '@shared/ipc'
import type { AgentInfo, Project, RateLimit, Session } from '@shared/types'
import type { Notice } from '../src/Log'
import { errorText } from '../src/errors'
import type { Link, PhoneLink } from './transport'

export type Info = { machine: string | null; defaultAgent: string; listItemReplies: boolean; theme: 'system' | 'light' | 'dark' }
export type Activity = { turn: string | null | undefined; requests: number; queued: number; paused: boolean }
export type OpenView = SessionView & { notices: Notice[] }

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

export function usePhone(link: PhoneLink) {
  const [state, setState] = useState<Link>(link.link)
  const [info, setInfo] = useState<Info | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimit[]>>({})
  const [activity, setActivity] = useState<Record<string, Activity>>({})
  const [open, setOpen] = useState<OpenView | null>(null)
  const openId = useRef<string | null>(null)

  const loadOpen = useCallback(async (id: string) => {
    try {
      const view = await window.gloss.sessions.open(id)
      if (openId.current === id) setOpen({ ...view, notices: [] })
    } catch (err) {
      if (openId.current === id) setOpen((o) => o && o.session.id === id ? addNotice(o, null, errorText(err)) : o)
    }
  }, [])

  const load = useCallback(async () => {
    const [i, p, s, a, r, act] = await Promise.all([
      link.invoke('bridge:info') as Promise<Info>,
      window.gloss.projects.list(),
      window.gloss.sessions.list(),
      window.gloss.agents.list(),
      window.gloss.agents.rateLimits(),
      link.invoke('bridge:activity') as Promise<Record<string, Activity>>
    ])
    setInfo(i)
    setProjects(p)
    setSessions(s.filter((x) => !x.draft && !x.review))
    setAgents(a)
    setRateLimits(r)
    setActivity(act)
    if (openId.current) await loadOpen(openId.current)
  }, [link, loadOpen])

  useEffect(() => link.onLink((l) => {
    setState(l)
    if (l === 'online') void load().catch(() => {})
  }), [link, load])

  useEffect(() => {
    if (link.link === 'online') void load().catch(() => {})
    link.connect()
  }, [link, load])

  useEffect(() => window.gloss.onEvent((event: GlossEvent) => {
    const sid = 'sessionId' in event ? event.sessionId : null
    const mine = (o: OpenView | null): o is OpenView => o !== null && o.session.id === sid
    const act = (id: string, change: (a: Activity) => Activity) => setActivity((all) => {
      const next = change(all[id] ?? { turn: undefined, requests: 0, queued: 0, paused: false })
      const copy = { ...all }
      if (next.turn === undefined && next.requests === 0 && next.queued === 0) delete copy[id]
      else copy[id] = next
      return copy
    })
    switch (event.type) {
      case 'session':
        if (event.session.draft || event.session.review) return
        setSessions((s) => upsert(s, event.session))
        setOpen((o) => o && o.session.id === event.session.id ? { ...o, session: event.session } : o)
        return
      case 'sessionDeleted':
        setSessions((s) => s.filter((x) => x.id !== event.sessionId))
        if (openId.current === event.sessionId) { openId.current = null; setOpen(null) }
        return
      case 'sessionCleared': case 'sessionRewound': case 'sessionSynced':
        if (openId.current === event.sessionId) void loadOpen(event.sessionId)
        return
      case 'message': {
        const m = event.message
        setOpen((o) => o && o.session.id === m.sessionId ? { ...o, messages: upsert(o.messages, m) } : o)
        return
      }
      case 'messageDeleted':
        setOpen((o) => mine(o) ? { ...o, messages: o.messages.filter((m) => m.id !== event.messageId) } : o)
        return
      case 'toolCall': {
        const t = event.toolCall
        setOpen((o) => o && o.session.id === t.sessionId ? { ...o, toolCalls: upsert(o.toolCalls, t) } : o)
        return
      }
      case 'plan': {
        const p = event.plan
        setOpen((o) => o && o.session.id === p.sessionId ? { ...o, plans: upsert(o.plans, p) } : o)
        return
      }
      case 'thread': {
        const t = event.thread
        setOpen((o) => o && o.session.id === t.sessionId ? { ...o, threads: upsert(o.threads, t) } : o)
        return
      }
      case 'live':
        setOpen((o) => mine(o) ? { ...o, live: event.live } : o)
        return
      case 'queue':
        act(event.sessionId, (a) => ({ ...a, queued: event.queue.items.length, paused: event.queue.paused }))
        setOpen((o) => mine(o) ? { ...o, queue: event.queue } : o)
        return
      case 'requests':
        act(event.sessionId, (a) => ({ ...a, requests: event.requests.length }))
        setOpen((o) => mine(o) ? { ...o, requests: event.requests } : o)
        return
      case 'turnStart':
        act(event.sessionId, (a) => ({ ...a, turn: event.threadId }))
        setOpen((o) => mine(o) ? { ...o, turn: { threadId: event.threadId } } : o)
        return
      case 'turnEnd':
        act(event.sessionId, (a) => ({ ...a, turn: undefined }))
        setOpen((o) => {
          if (!mine(o)) return o
          const next = { ...o, turn: null }
          if (event.stopReason === 'cancelled') return addNotice(next, event.threadId, 'Cancelled.')
          return event.error ? addNotice(next, event.threadId, `The turn failed: ${event.error}`, 'failed') : next
        })
        return
      case 'notice':
        setOpen((o) => mine(o) ? addNotice(o, event.threadId, event.text) : o)
        return
      case 'rateLimits':
        setRateLimits((r) => ({ ...r, [event.agentId]: event.limits }))
        return
      case 'agents':
        setAgents(event.agents)
        return
    }
  }), [loadOpen])

  // Tells the desktop which session is on screen, so it doesn't push about it (SPEC → Remote and mobile).
  const openSessionId = open?.session.id ?? null
  useEffect(() => {
    if (state !== 'online') return
    const report = (): void => void link.invoke('bridge:viewing', document.visibilityState === 'visible' ? openSessionId : null).catch(() => {})
    report()
    document.addEventListener('visibilitychange', report)
    return () => document.removeEventListener('visibilitychange', report)
  }, [link, state, openSessionId])

  const openSession = useCallback((id: string | null) => {
    openId.current = id
    setOpen(null)
    if (id) void loadOpen(id)
  }, [loadOpen])

  /** Shows an error in a thread's log. */
  const notice = useCallback((threadId: string | null, text: string) => {
    setOpen((o) => o ? addNotice(o, threadId, text) : o)
  }, [])

  return { link: state, info, projects, sessions, agents, rateLimits, activity, open, setOpen, openSession, notice }
}

export type Phone = ReturnType<typeof usePhone>

function addNotice(o: OpenView, threadId: string | null, text: string, tone?: 'failed'): OpenView {
  const afterSeq = Math.max(-1, ...o.messages.map((m) => m.seq), ...o.toolCalls.map((t) => t.messageSeq))
  return { ...o, notices: [...o.notices, { id: `${Date.now()}-${o.notices.length}`, threadId, text, afterSeq, ...(tone ? { tone } : {}) }] }
}
