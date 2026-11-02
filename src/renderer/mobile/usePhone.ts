// The phone's view of the desktop (SPEC → Remote and mobile): the lists, what runs or waits where,
// and the open session, kept current from the bridge's events. Everything reloads on reconnect.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ForkOf, ForkView, GlossEvent, SessionView } from '@shared/ipc'
import type { AgentInfo, Project, RateLimit, Session } from '@shared/types'
import type { SessionOrder } from '@shared/settings'
import type { Notice } from '../src/Log'
import { errorText } from '../src/errors'
import type { Link, PhoneLink } from './transport'

/** `sessionOrder`: the desktop sidebar's (Settings → General). */
export type Info = { machine: string | null; defaultAgent: string; theme: 'system' | 'light' | 'dark'; sessionOrder?: SessionOrder }
/** `forkOf`: a fork thread's session, whose work shows in its parent (SPEC → Fork threads). */
export type Activity = { turn: string | null | undefined; requests: number; queued: number; paused: boolean; forkOf?: ForkOf }
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
    void reloadIfStale(link)
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
    // A fork thread's turn, queue, status and requests are its own (SPEC → Fork threads).
    const forkOf = 'forkOf' in event ? event.forkOf : undefined
    if (forkOf && sid) {
      const lane = (change: (f: ForkView) => ForkView) => setOpen((o) => {
        if (!o || o.session.id !== forkOf.sessionId) return o
        const known = o.forks.find((f) => f.sessionId === sid)
        const fork = known ?? { threadId: forkOf.threadId, sessionId: sid, running: false, queue: { items: [], paused: false }, live: o.live, requests: [] }
        return { ...o, forks: [...o.forks.filter((f) => f !== known), change(fork)] }
      })
      const act = (change: (a: Activity) => Activity) => setActivity((all) => {
        const next = change(all[sid] ?? { turn: undefined, requests: 0, queued: 0, paused: false, forkOf })
        const copy = { ...all }
        if (next.turn === undefined && next.requests === 0 && next.queued === 0) delete copy[sid]
        else copy[sid] = next
        return copy
      })
      switch (event.type) {
        case 'live': return lane((f) => ({ ...f, live: event.live }))
        case 'queue':
          act((a) => ({ ...a, queued: event.queue.items.length, paused: event.queue.paused }))
          return lane((f) => ({ ...f, queue: event.queue }))
        case 'requests':
          act((a) => ({ ...a, requests: event.requests.length }))
          return lane((f) => ({ ...f, requests: event.requests }))
        case 'turnStart':
          act((a) => ({ ...a, turn: event.threadId }))
          return lane((f) => ({ ...f, running: true }))
        case 'turnEnd':
          act((a) => ({ ...a, turn: undefined }))
          lane((f) => ({ ...f, running: false }))
          setOpen((o) => {
            if (!o || o.session.id !== forkOf.sessionId) return o
            if (event.stopReason === 'cancelled') return addNotice(o, forkOf.threadId, 'Cancelled.')
            return event.error ? addNotice(o, forkOf.threadId, `The turn failed: ${event.error}`, 'failed') : o
          })
          return
      }
    }
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

  /** `cached`: the session as last seen, shown until it has reloaded (a swipe forward back into it). */
  const openSession = useCallback((id: string | null, cached?: OpenView) => {
    openId.current = id
    setOpen(cached && cached.session.id === id ? cached : null)
    if (id) void loadOpen(id)
  }, [loadOpen])

  /** Shows an error in a thread's log. */
  const notice = useCallback((threadId: string | null, text: string) => {
    setOpen((o) => o ? addNotice(o, threadId, text) : o)
  }, [])

  /** What runs or waits, by listed session: a fork thread's work is its parent's, in that thread. */
  const shownActivity = useMemo(() => {
    const out: Record<string, Activity> = {}
    for (const [id, a] of Object.entries(activity)) if (!a.forkOf) out[id] = a
    for (const a of Object.values(activity)) {
      if (!a.forkOf) continue
      const own = out[a.forkOf.sessionId]
      const turn = a.turn !== undefined ? a.forkOf.threadId : undefined
      out[a.forkOf.sessionId] = own
        ? { ...own, turn: own.turn !== undefined ? own.turn : turn, requests: own.requests + a.requests, queued: own.queued + a.queued, paused: own.paused || a.paused }
        : { turn, requests: a.requests, queued: a.queued, paused: a.paused }
    }
    return out
  }, [activity])

  return { link: state, info, projects, sessions, agents, rateLimits, activity: shownActivity, open, setOpen, openSession, notice }
}

export type Phone = ReturnType<typeof usePhone>

/**
 * Reloads the page when the desktop now serves a different build of it (Gloss was rebuilt and
 * restarted while this page stayed open). Waits for the next reconnect while a field holds text.
 */
async function reloadIfStale(link: PhoneLink): Promise<void> {
  const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src')
  const served = await (link.invoke('bridge:build') as Promise<string | null>).catch(() => null)
  if (!mine || !served || served === mine) return
  const typing = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input')].some((f) => f.value.trim() !== '')
  if (!typing) location.reload()
}

function addNotice(o: OpenView, threadId: string | null, text: string, tone?: 'failed'): OpenView {
  const afterSeq = Math.max(-1, ...o.messages.map((m) => m.seq), ...o.toolCalls.map((t) => t.messageSeq))
  return { ...o, notices: [...o.notices, { id: `${Date.now()}-${o.notices.length}`, threadId, text, afterSeq, ...(tone ? { tone } : {}) }] }
}
