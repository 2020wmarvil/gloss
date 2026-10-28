// The phone client (SPEC → Remote and mobile; docs/mocks/mobile.html): sessions, the conversation,
// threads full screen, the composer with queue and steer, questions and approvals, and the status sheet.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Clock, CornerDownRight, Folder, Hand, Lock,
  MessageSquare, MessageSquareReply, Pencil, Plus, Shield, Square, Trash2, WifiOff, X
} from 'lucide-react'
import type { Anchor, Attachment, Message, Plan, PlanUsage, Session, Thread, ToolCall } from '@shared/types'
import { lineLabel } from '@shared/review'
import { truncate } from '@shared/wire'
import { errorText } from '../src/errors'
import { logItems, type LogItem, type Notice } from '../src/Log'
import { Markdown } from '../src/Markdown'
import { RequestCard } from '../src/RequestCard'
import { resetIn } from '../src/UsagePanel'
import { hasDetails, ToolDetails } from '../src/ToolDetails'
import { rangeToSource } from '../src/selection'
import { renderedText, resolveSelection } from '../src/source'
import type { Mark } from '../src/sourceSpans'
import type { ListItemSpan } from '../src/anchors'
import { applyTheme } from '../src/theme'
import { usePhone, upsert, type OpenView, type Phone } from './usePhone'
import type { PhoneLink } from './transport'
import { NotifyCard } from './notify'

type Panel = { anchorMessageId: string | null; anchor: Anchor; threadId: string | null }
/** What the bottom bar offers to reply to: a tapped block or a selection in an agent message. */
type Target = { message: Message; anchor: Anchor; selection: boolean }

const MAX_IMAGE = 10 * 1024 * 1024

export function threadName(thread: Thread): string {
  if (thread.finding) return truncate(thread.finding.title, 40)
  return thread.anchor.kind === 'line' ? lineLabel(thread.anchor) : truncate(thread.anchor.text, 40)
}

export function MobileApp({ link }: { link: PhoneLink }): React.JSX.Element {
  const phone = usePhone(link)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [screen, setScreen] = useState<'main' | 'threads'>('main')

  useEffect(() => applyTheme(phone.info?.theme ?? 'system'), [phone.info?.theme])

  // A notification's tap opens its session and thread (the service worker passes them on).
  const pendingOpen = useRef<{ session: string; thread: string | null } | null>(null)
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const session = q.get('session')
    if (session) {
      pendingOpen.current = { session, thread: q.get('thread') }
      history.replaceState(null, '', '/')
    }
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { type?: string; sessionId?: string; threadId?: string | null }
      if (d?.type === 'open' && d.sessionId) {
        pendingOpen.current = { session: d.sessionId, thread: d.threadId ?? null }
        phone.openSession(d.sessionId)
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [phone.openSession])
  useEffect(() => {
    const p = pendingOpen.current
    if (!p || phone.link !== 'online') return
    if (phone.open?.session.id !== p.session) {
      phone.openSession(p.session)
      return
    }
    pendingOpen.current = null
    const t = p.thread ? phone.open.threads.find((x) => x.id === p.thread) : undefined
    setPanel(t ? { anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id } : null)
  }, [phone.link, phone.open, phone.openSession])

  if (phone.link === 'removed') {
    return (
      <div className="m-screen m-center">
        <Lock size={40} className="m-faint" />
        <h3>This phone was removed</h3>
        <p>Gloss{phone.info?.machine ? ` on ${phone.info.machine}` : ''} no longer accepts this phone. To use it again, pair it from Gloss's Settings on the computer.</p>
      </div>
    )
  }

  const offline = phone.link === 'offline' || (phone.link === 'connecting' && phone.info !== null)
  const open = phone.open
  return (
    <div className={`m-screen${offline ? ' m-offline' : ''}`}>
      {offline && (
        <div className="m-banner m-banner-off" role="status">
          <WifiOff size={18} /><span><b>Gloss is offline.</b> Reconnecting…</span>
        </div>
      )}
      {!open ? (
        phone.open === null && phone.info === null && phone.link === 'connecting'
          ? <div className="m-center"><span className="m-bead lg" /><p>Connecting…</p></div>
          : <Sessions phone={phone} onOpen={(id) => { setPanel(null); setScreen('main'); phone.openSession(id) }} />
      ) : screen === 'threads' ? (
        <ThreadsList open={open} onBack={() => setScreen('main')} onOpen={(t) => { setPanel({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id }); setScreen('main') }} />
      ) : (
        <SessionScreen
          phone={phone}
          open={open}
          panel={panel}
          setPanel={setPanel}
          offline={offline}
          onBack={() => phone.openSession(null)}
          onThreads={() => setScreen('threads')}
        />
      )}
    </div>
  )
}

// Sessions

function Sessions({ phone, onOpen }: { phone: Phone; onOpen(id: string): void }): React.JSX.Element {
  const [project, setProject] = useState<string | null>(null)
  const [picker, setPicker] = useState<'projects' | 'agents' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = phone.projects.find((p) => p.path === project) ?? phone.projects[0]
  const needs = (s: Session) => (phone.activity[s.id]?.requests ?? 0) > 0
  const list = phone.sessions
    .filter((s) => current && s.cwd.toLowerCase() === current.path.toLowerCase())
    .sort((a, b) => Number(needs(b)) - Number(needs(a)) || (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt))
  const agentName = (id: string) => phone.agents.find((a) => a.id === id)?.name ?? id
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const held = useRef(false)

  async function create(agentId: string): Promise<void> {
    if (!current) return
    setPicker(null)
    setError(null)
    try {
      const s = await window.gloss.sessions.create(current.path, agentId)
      onOpen(s.id)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const waiting = list.filter(needs)
  const rest = list.filter((s) => !needs(s))
  return (
    <>
      <div className="m-proj">
        <span className="m-bead" />
        <button className="m-pick" onClick={() => setPicker('projects')} disabled={phone.projects.length === 0}>
          {current?.name ?? 'Gloss'} <ChevronDown size={16} />
        </button>
      </div>
      <div className="m-body m-scroll">
        <NotifyCard />
        {error && <p className="m-error" role="alert">{error}</p>}
        {!current && phone.info && <p className="m-empty">Open a project in Gloss on the computer to start.</p>}
        {waiting.length > 0 && <div className="m-sec">Needs you</div>}
        {waiting.map((s) => <SessionRow key={s.id} s={s} phone={phone} agentName={agentName(s.agentId)} onOpen={onOpen} />)}
        {rest.length > 0 && <div className="m-sec">Sessions</div>}
        {rest.map((s) => <SessionRow key={s.id} s={s} phone={phone} agentName={agentName(s.agentId)} onOpen={onOpen} />)}
        <div className="m-fab-space" />
      </div>
      {current && (
        <button
          className="m-fab"
          onPointerDown={() => { held.current = false; hold.current = setTimeout(() => { held.current = true; setPicker('agents') }, 500) }}
          onPointerUp={() => clearTimeout(hold.current)}
          onPointerLeave={() => clearTimeout(hold.current)}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => { if (!held.current) void create(phone.info?.defaultAgent ?? 'claude') }}
        >
          <Plus size={18} />New session
        </button>
      )}
      {picker === 'projects' && (
        <Sheet title="Projects" onClose={() => setPicker(null)}>
          {phone.projects.map((p) => {
            const here = phone.sessions.filter((s) => s.cwd.toLowerCase() === p.path.toLowerCase())
            const waits = here.filter((s) => (phone.activity[s.id]?.requests ?? 0) > 0).length
            const runs = here.some((s) => phone.activity[s.id]?.turn !== undefined)
            return (
              <button key={p.path} className="m-kv m-kv-btn" onClick={() => { setProject(p.path); setPicker(null) }}>
                <Folder size={18} /><span className="m-k m-ink">{p.name}</span>
                <span className="m-v">
                  {waits > 0 && <span className="m-pill m-wait">{waits} waiting</span>}
                  {runs && <span className="m-dot m-pulse s-working" />}
                  {p.path === current?.path && <Check size={16} className="m-accent" />}
                </span>
              </button>
            )
          })}
        </Sheet>
      )}
      {picker === 'agents' && (
        <Sheet title="New session with" onClose={() => setPicker(null)}>
          {phone.agents.filter((a) => a.available !== false).map((a) => (
            <button key={a.id} className="m-kv m-kv-btn" onClick={() => void create(a.id)}>
              <span className="m-k m-ink">{a.name}</span>
              {a.id === phone.info?.defaultAgent && <span className="m-v m-small">Default</span>}
            </button>
          ))}
        </Sheet>
      )}
    </>
  )
}

function SessionRow({ s, phone, agentName, onOpen }: { s: Session; phone: Phone; agentName: string; onOpen(id: string): void }): React.JSX.Element {
  const a = phone.activity[s.id]
  return (
    <button className="m-row" onClick={() => onOpen(s.id)}>
      <span className="m-lead">
        {a?.requests ? <span className="m-dot s-wait" /> : a?.turn !== undefined ? <span className="m-dot m-pulse s-working" /> : null}
      </span>
      <span className="m-row-main">
        <b>{s.title}</b>
        <small>
          {a?.requests ? <span className="m-pill m-wait"><Hand size={12} />Waiting for you</span>
            : a?.turn !== undefined ? <span className="s-working">Working</span> : null}
          <span>{agentName}</span>
          {a?.queued ? <span className={a.paused ? 's-paused' : 's-queued'}>{a.queued} queued{a.paused ? ', paused' : ''}</span> : null}
        </small>
      </span>
      <span className="m-when">{when(s.activeAt ?? s.createdAt)}</span>
    </button>
  )
}

function when(at: number): string {
  const d = Date.now() - at
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// A session: the main conversation or a thread, full screen

function SessionScreen(props: {
  phone: Phone; open: OpenView; panel: Panel | null; setPanel(p: Panel | null): void; offline: boolean
  onBack(): void; onThreads(): void
}): React.JSX.Element {
  const { phone, open, panel, setPanel } = props
  const [target, setTarget] = useState<Target | null>(null)
  const [sheet, setSheet] = useState<StatusPart | null>(null)
  const threadId = panel?.threadId ?? null
  const inThread = panel !== null
  const agentName = phone.agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId
  const runningThread = open.turn ? open.turn.threadId : undefined
  const thread = threadId ? open.threads.find((t) => t.id === threadId) : undefined
  const visibleThreads = open.threads.filter((t) => t.anchor.kind !== 'line' && !t.finding)

  useEffect(() => setTarget(null), [panel, open.session.id])

  function reply(): void {
    if (!target) return
    const { message, anchor } = target
    const existing = open.threads.find((t) => t.anchorMessageId === message.id && sameAnchor(t.anchor, anchor))
    window.getSelection()?.removeAllRanges()
    setTarget(null)
    setPanel(existing ? { anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id } : { anchorMessageId: message.id, anchor, threadId: null })
  }

  return (
    <>
      <div className="m-hdr">
        {inThread ? (
          <button className="m-back" onClick={() => setPanel(null)}><ArrowLeft size={18} />Main</button>
        ) : (
          <button className="m-back" onClick={props.onBack} aria-label="Sessions"><ArrowLeft size={18} /></button>
        )}
        <div className="m-hdr-t">
          {!inThread && <><b>{open.session.title}</b><small>{agentName}</small></>}
        </div>
        {!inThread && (
          <button className="m-ib" onClick={props.onThreads} aria-label="Threads">
            <MessageSquare size={18} />{visibleThreads.length > 0 && <span className="m-badge">{visibleThreads.length}</span>}
          </button>
        )}
      </div>
      {inThread && (
        <div className="m-quote"><small>Thread</small>{thread ? (thread.anchor.kind === 'line' ? lineLabel(thread.anchor) : thread.anchor.text) : panel.anchor.kind === 'line' ? lineLabel(panel.anchor) : panel.anchor.text}</div>
      )}
      <LogView
        open={open}
        threadId={threadId}
        inThread={inThread}
        listItemReplies={phone.info?.listItemReplies ?? false}
        runningThread={runningThread}
        target={target}
        onTarget={setTarget}
        onOpenThread={(id) => {
          const t = open.threads.find((x) => x.id === id)
          if (t) setPanel({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
        }}
        key={`${open.session.id}:${threadId ?? panel?.anchorMessageId ?? 'main'}`}
      />
      {target ? (
        <div className="m-selbar">
          <button className="m-act" onClick={() => { window.getSelection()?.removeAllRanges(); setTarget(null) }} aria-label="Dismiss"><X size={16} /></button>
          {!target.selection && <button className="m-act" onClick={() => { void navigator.clipboard.writeText(target.anchor.kind === 'line' ? '' : target.anchor.text); setTarget(null) }}>Copy</button>}
          <button className="m-act m-pri" onClick={reply}><MessageSquareReply size={16} />{target.selection ? 'Reply to selection' : 'Reply in thread'}</button>
        </div>
      ) : (
        <div className="m-foot">
          {!inThread && open.turn && (
            <button className="m-strip" onClick={() => {
              const t = open.turn?.threadId ? open.threads.find((x) => x.id === open.turn?.threadId) : undefined
              if (t) setPanel({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
            }}>
              <span className="m-dot m-pulse s-working" />
              <span className="m-grow">Working in {open.turn.threadId ? `“${threadName(open.threads.find((x) => x.id === open.turn?.threadId) ?? ({ anchor: { kind: 'selection', start: 0, end: 0, text: 'a thread' } } as Thread))}”` : 'main conversation'}</span>
              {open.queue.items.length > 0 && <span className="s-queued m-small-b">{open.queue.items.length} queued</span>}
              <ChevronRight size={14} />
            </button>
          )}
          <Composer
            key={`${open.session.id}:${threadId ?? panel?.anchorMessageId ?? 'main'}`}
            phone={phone}
            open={open}
            panel={panel}
            onThread={(t) => setPanel(panel ? { ...panel, threadId: t.id } : null)}
            offline={props.offline}
          />
          <StatusRow open={open} onOpen={setSheet} />
        </div>
      )}
      {sheet && <StatusSheet open={open} part={sheet} onClose={() => setSheet(null)} />}
    </>
  )
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind === 'listItem' && b.kind === 'listItem') return a.path.join() === b.path.join()
  if (a.kind === 'selection' && b.kind === 'selection') return a.start === b.start && a.end === b.end
  return false
}

// The log

function LogView(props: {
  open: OpenView; threadId: string | null; inThread: boolean; listItemReplies: boolean; runningThread: string | null | undefined
  target: Target | null; onTarget(t: Target | null): void; onOpenThread(id: string): void
}): React.JSX.Element {
  const { open, threadId, target } = props
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const items = useMemo(
    () => props.inThread && threadId === null ? [] : logItems({ ...open, requests: open.requests }, open.notices, threadId),
    [open, threadId, props.inThread]
  )
  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of open.messages) if (m.threadId !== null) counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1)
    return counts
  }, [open.messages])

  // Follows new output while at the bottom.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })

  // A selection in an agent message offers Reply to selection.
  useEffect(() => {
    if (props.inThread) return
    const onChange = (): void => {
      const s = window.getSelection()
      if (!s || s.isCollapsed || s.rangeCount === 0) {
        if (props.target?.selection) props.onTarget(null)
        return
      }
      const found = messageAt(s.getRangeAt(0).commonAncestorContainer)
      if (!found) return
      const r = rangeToSource(found.root, s.getRangeAt(0), found.message.text)
      const text = r ? renderedText(found.message.text, r.start, r.end) : ''
      if (r && text) props.onTarget({ message: found.message, anchor: { kind: 'selection', start: r.start, end: r.end, text }, selection: true })
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  })

  function messageAt(node: Node): { root: HTMLElement; message: Message } | null {
    const el = node instanceof Element ? node : node.parentElement
    const root = el?.closest<HTMLElement>('[data-message-id]')
    if (!root || !scroller.current?.contains(root)) return null
    const message = open.messages.find((m) => m.id === root.dataset.messageId)
    return message && message.role === 'agent' ? { root, message } : null
  }

  /** A tap on a list item or paragraph of an agent message offers Reply in thread (SPEC → Remote and mobile). */
  function tap(e: React.MouseEvent): void {
    if (props.inThread) return
    const el = e.target as HTMLElement
    if (el.closest('button, a, input, textarea, select, .request, .m-tools, .code-block')) return
    if (window.getSelection()?.isCollapsed === false) return
    const found = messageAt(el)
    if (!found) {
      props.onTarget(null)
      return
    }
    const li = el.closest<HTMLElement>('li.anchor-item')
    if (li && found.root.contains(li)) {
      li.querySelector<HTMLButtonElement>(':scope > .item-reply')?.click()
      return
    }
    const block = el.closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th')
    if (!block || !found.root.contains(block)) return
    const range = document.createRange()
    range.selectNodeContents(block)
    const r = rangeToSource(found.root, range, found.message.text)
    const text = r ? renderedText(found.message.text, r.start, r.end) : ''
    if (r && text) props.onTarget({ message: found.message, anchor: { kind: 'selection', start: r.start, end: r.end, text }, selection: false })
  }

  function marksFor(message: Message): Mark[] {
    const marks: Mark[] = []
    for (const t of open.threads) {
      if (t.anchorMessageId !== message.id || t.anchor.kind !== 'selection') continue
      const r = resolveSelection(message.text, t.anchor)
      if (r) marks.push({ ...r, threadId: t.id, title: t.anchor.text })
    }
    if (target && target.message.id === message.id && target.anchor.kind === 'selection' && !target.selection) {
      marks.push({ start: target.anchor.start, end: target.anchor.end, threadId: null })
    }
    return marks
  }

  function agent(message: Message): React.JSX.Element {
    if (props.inThread) return <Markdown text={message.text} />
    const itemThread = (index: number) => open.threads.find((t) => t.anchorMessageId === message.id && t.anchor.kind === 'listItem' && t.anchor.path[0] === index)
    const running = open.threads.find((t) => t.id === props.runningThread)
    const activeIndex = target?.message.id === message.id && target.anchor.kind === 'listItem' ? target.anchor.path[0] : null
    return (
      <Markdown
        text={message.text}
        listItemReplies
        anchors={{
          replyCount: (i) => { const t = itemThread(i); return t ? replyCounts.get(t.id) ?? 0 : 0 },
          activeIndex,
          runningIndex: running?.anchorMessageId === message.id && running.anchor.kind === 'listItem' ? running.anchor.path[0] : null,
          onOpenItem: (span: ListItemSpan) => {
            const t = itemThread(span.index)
            // A reply badge opens its thread; a tap on the item offers to reply.
            if (t && (replyCounts.get(t.id) ?? 0) > 0 && activeIndex === null && !props.target) props.onTarget({ message, anchor: t.anchor, selection: false })
            else props.onTarget({ message, anchor: { kind: 'listItem', path: [span.index], text: span.text }, selection: false })
          },
          marks: marksFor(message),
          threadCount: (id) => replyCounts.get(id) ?? 0,
          runningThread: props.runningThread ?? null,
          onOpenThread: props.onOpenThread
        }}
      />
    )
  }

  // Runs of tool calls share one box, as on the desktop.
  const groups: (LogItem | { kind: 'tools'; seq: number; calls: ToolCall[] })[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.calls.push(item.toolCall)
      else groups.push({ kind: 'tools', seq: item.seq, calls: [item.toolCall] })
    } else groups.push(item)
  }

  return (
    <div
      className="m-body m-scroll m-log"
      ref={scroller}
      onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
      onClick={tap}
    >
      {groups.length === 0 && <p className="m-empty">{props.inThread ? 'Reply to start the thread.' : 'Send a message to start.'}</p>}
      {groups.map((g) => {
        switch (g.kind) {
          case 'message':
            return g.message.role === 'user' ? (
              <div key={g.message.id} className="m-you">
                <Markdown text={g.message.text} breaks />
                <SentImages attachments={g.message.attachments} />
                <span className="m-meta">{g.message.steered ? 'steered · ' : ''}{g.message.createdAt ? new Date(g.message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
              </div>
            ) : (
              <div key={g.message.id} className="m-agent" data-message-id={g.message.id}>{agent(g.message)}</div>
            )
          case 'sentToMain':
            return <div key={`main-${g.message.id}`} className="m-note">Continued in the main conversation: {truncate(g.message.text, 80)}</div>
          case 'tools':
            return <Tools key={`tools-${g.calls[0].id}`} calls={g.calls} />
          case 'plan':
            return <PlanView key={g.plan.id} plan={g.plan} />
          case 'notice':
            return <NoticeView key={g.notice.id} notice={g.notice} />
          case 'request':
            return <RequestCard key={g.request.id} request={g.request} />
          default:
            return null
        }
      })}
    </div>
  )
}

/** A sent message's images, as on the desktop; a tap shows one full screen. */
function SentImages({ attachments }: { attachments?: Attachment[] }): React.JSX.Element | null {
  const [shown, setShown] = useState<string | null>(null)
  const images = (attachments ?? []).flatMap((a) => a.kind === 'image' ? [{ name: a.name, src: `data:${a.mimeType};base64,${a.data}` }] : [])
  if (images.length === 0) return null
  return (
    <>
      <div className="m-sent-images">
        {images.map((img, i) => (
          <button key={i} onClick={() => setShown(img.src)} aria-label={`View ${img.name}`}><img src={img.src} alt={img.name} /></button>
        ))}
      </div>
      {shown && (
        <button className="m-lightbox" onClick={() => setShown(null)} aria-label="Close image"><img src={shown} alt="" /></button>
      )}
    </>
  )
}

function Tools({ calls }: { calls: ToolCall[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="m-tools">
      {calls.map((t) => (
        <div key={t.id}>
          <button className="m-tr" onClick={() => setExpanded(expanded === t.id ? null : t.id)} disabled={!hasDetails(t)}>
            <code>{t.title}</code>
            {t.status === 'completed' ? <Check size={14} className="s-done" /> : t.status === 'failed' ? <span className="s-failed m-small-b">failed</span> : <span className="m-dot m-pulse s-working" />}
          </button>
          {expanded === t.id && <div className="m-tool-details"><ToolDetails toolCall={t} /></div>}
        </div>
      ))}
    </div>
  )
}

function PlanView({ plan }: { plan: Plan }): React.JSX.Element {
  const done = plan.entries.filter((e) => e.status === 'completed').length
  return (
    <div className="m-plan">
      <div className="m-small">{done} of {plan.entries.length} done</div>
      {plan.entries.map((e, i) => (
        <div key={i} className={`m-plan-row ${e.status}`}>
          {e.status === 'completed' ? <Check size={14} className="s-done" /> : e.status === 'in_progress' ? <span className="m-dot m-pulse s-working" /> : <span className="m-dot m-faint" />}
          <span>{e.content}</span>
        </div>
      ))}
    </div>
  )
}

function NoticeView({ notice }: { notice: Notice }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className={notice.tone === 'failed' ? 'm-notice m-notice-failed' : 'm-notice'}>
      {notice.text}
      {notice.action && (
        <button className="m-dbtn" disabled={busy} onClick={() => { setBusy(true); void notice.action!.run().finally(() => setBusy(false)) }}>{notice.action.label}</button>
      )}
    </div>
  )
}

// Composer

function Composer(props: { phone: Phone; open: OpenView; panel: Panel | null; onThread(t: Thread): void; offline: boolean }): React.JSX.Element {
  const { open, panel } = props
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const threadId = panel?.threadId ?? null
  const runningHere = open.turn !== null && open.turn.threadId === threadId && (panel === null || panel.threadId !== null)
  const mode: 'send' | 'steer' | 'queue' = runningHere && open.live.steering ? 'steer' : open.turn ? 'queue' : 'send'
  const queued = open.queue.items.filter((q) => q.threadId === threadId && (panel === null || panel.threadId !== null))
  const commands = text.startsWith('/') && !/\s/.test(text) ? open.live.commands.filter((c) => c.name.startsWith(text.slice(1))).slice(0, 6) : []

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  useEffect(() => { if (panel && panel.threadId === null) area.current?.focus() }, [panel])

  async function submit(): Promise<void> {
    const body = text.trim()
    if (!body && images.length === 0) return
    setError(null)
    const attachments = images
    setText('')
    setImages([])
    try {
      let id = threadId
      if (panel && id === null) {
        const t = await window.gloss.threads.create(open.session.id, panel.anchorMessageId, panel.anchor)
        props.phone.setOpen((o) => o && o.session.id === t.sessionId ? { ...o, threads: upsert(o.threads, t) } : o)
        props.onThread(t)
        id = t.id
      }
      if (mode === 'steer') await window.gloss.steer(open.session.id, body, id, attachments)
      else await window.gloss.send(open.session.id, body, id, attachments)
    } catch (err) {
      setText(body)
      setImages(attachments)
      setError(errorText(err))
    }
  }

  async function addImages(files: FileList | null): Promise<void> {
    for (const f of [...(files ?? [])]) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > MAX_IMAGE) { setError(`${f.name} is over 10 MB.`); continue }
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
        r.onerror = () => reject(r.error ?? new Error('Could not read the image'))
        r.readAsDataURL(f)
      })
      setImages((list) => [...list, { kind: 'image', name: f.name || 'photo.jpg', mimeType: f.type, data }])
    }
  }

  return (
    <>
      {queued.length > 0 && (
        <div className="m-qlist">
          <div className={`m-qhead${open.queue.paused ? ' paused' : ''}`}>
            <Clock size={14} /><span className="m-grow">{queued.length} queued{open.queue.paused ? ', paused' : ''}</span>
            {open.queue.paused && <button className="m-resume" onClick={() => void window.gloss.queue.resume(open.session.id).catch((e: unknown) => setError(errorText(e)))}>Resume</button>}
          </div>
          {queued.slice().reverse().map((q) => editing?.id === q.id ? (
            <div key={q.id} className={`m-qi${open.queue.paused ? ' paused' : ''}`}>
              <textarea className="m-qedit" value={editing.text} onChange={(e) => setEditing({ id: q.id, text: e.target.value })} autoFocus />
              <button className="m-ib sm" aria-label="Save" onClick={() => { void window.gloss.queue.edit(open.session.id, q.id, editing.text); setEditing(null) }}><Check size={16} /></button>
            </div>
          ) : (
            <div key={q.id} className={`m-qi${open.queue.paused ? ' paused' : ''}`}>
              <span className="m-grow m-ellipsis">{q.text}</span>
              <button className="m-ib sm" aria-label="Edit" onClick={() => setEditing({ id: q.id, text: q.text })}><Pencil size={14} /></button>
              <button className="m-ib sm" aria-label="Remove" onClick={() => void window.gloss.queue.remove(open.session.id, q.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {commands.length > 0 && (
        <div className="m-commands">
          {commands.map((c) => (
            <button key={c.name} className="m-command" onClick={() => setText(`/${c.name} `)}>
              <b>/{c.name}</b><span>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="m-error" role="alert">{error}</p>}
      {images.length > 0 && (
        <div className="m-thumbs">
          {images.map((a, i) => a.kind === 'image' && (
            <span key={i} className="m-thumb">
              <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
              <button aria-label={`Remove ${a.name}`} onClick={() => setImages((l) => l.filter((_, j) => j !== i))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="m-comp">
        {open.live.accepts.image && (
          <>
            <button className="m-ib" aria-label="Attach images" onClick={() => file.current?.click()} disabled={props.offline}><Plus size={20} /></button>
            <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { void addImages(e.target.files); e.target.value = '' }} />
          </>
        )}
        <textarea
          ref={area}
          className="m-txt"
          rows={1}
          value={text}
          placeholder={panel ? 'Reply in thread' : 'Message'}
          disabled={props.offline}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className={`m-send${mode === 'queue' ? ' queue' : ''}${mode === 'send' ? ' round' : ''}`}
          disabled={props.offline || (!text.trim() && images.length === 0)}
          onClick={() => void submit()}
          aria-label={mode === 'send' ? 'Send' : undefined}
        >
          {mode === 'send' ? <ArrowUp size={18} /> : mode === 'steer' ? <><CornerDownRight size={15} />Steer</> : <><Clock size={15} />Queue</>}
        </button>
        {runningHere && (
          <button className="m-send stop" aria-label="Stop" disabled={props.offline} onClick={() => void window.gloss.cancel(open.session.id).catch((e: unknown) => setError(errorText(e)))}>
            <Square size={14} />
          </button>
        )}
      </div>
    </>
  )
}

// Status

function choiceName(choice: { current: string; options: { value: string; name: string; description?: string }[] } | null): string | null {
  if (!choice) return null
  const o = choice.options.find((x) => x.value === choice.current)
  if (!o) return choice.current
  return o.value === 'default' && o.description ? o.description.split(/[.(·]/)[0].trim() : o.name
}

const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' }

/** Which part of the status a pill opens: usage (context, limits, cost) or one picker. */
type StatusPart = 'usage' | 'model' | 'effort' | 'mode'

function StatusRow({ open, onOpen }: { open: OpenView; onOpen(part: StatusPart): void }): React.JSX.Element {
  const { live } = open
  const pct = live.usage ? Math.round((live.usage.used / live.usage.size) * 100) : null
  // Weekly limits stay in the usage sheet, as on the desktop.
  const limits = live.rateLimits.filter((r) => !/^seven_day(?:_|$)/.test(r.window))
  const waiting = (open.requests ?? []).length > 0
  return (
    <div className="m-stat" role="toolbar" aria-label="Session status">
      {waiting && <span className="m-sp warn"><Hand size={13} />Waiting for you</span>}
      {open.queue.paused && open.queue.items.length > 0 && (
        <button className="m-sp paused" onClick={() => void window.gloss.queue.resume(open.session.id)}>{open.queue.items.length} queued, paused · Resume</button>
      )}
      {(pct !== null || limits.length > 0) && (
        <button className={`m-sp${(pct ?? 0) >= 80 || limits.some((l) => l.status !== 'allowed') ? ' warn' : ''}`} onClick={() => onOpen('usage')}>
          {pct !== null && <><span className="m-lbl">Context</span><span className="m-meter"><i style={{ width: `${Math.min(pct, 100)}%` }} /></span>{pct}%</>}
          {limits.map((l, i) => (
            <span key={l.window} style={{ display: 'contents' }}>
              {(pct !== null || i > 0) && <span className="m-sp-sep">·</span>}
              <span className="m-lbl">{WINDOW_LABELS[l.window] ?? l.window}</span>{limitText(l)}
            </span>
          ))}
        </button>
      )}
      {live.model && <button className="m-sp" onClick={() => onOpen('model')}>{choiceName(live.model)}</button>}
      {live.effort && <button className="m-sp" onClick={() => onOpen('effort')}>{choiceName(live.effort)}</button>}
      {live.modes && <button className="m-sp" onClick={() => onOpen('mode')}><Shield size={13} />{choiceName(live.modes)}</button>}
      {!live.modes && live.attached && (
        <button className="m-sp" onClick={() => void window.gloss.sessions.setAutoApprove(open.session.id, !live.autoApprove)}>
          <Shield size={13} />{live.autoApprove ? 'Auto-approve' : 'Ask'}
        </button>
      )}
      {!live.attached && !open.turn && <span className="m-sp">Agent not running</span>}
    </div>
  )
}

function limitText(r: { status: string; utilization?: number }): string {
  return r.status === 'rejected' ? 'reached' : r.utilization !== undefined ? `${Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization)}%` : 'OK'
}

/** One pill's part: the usage it summarizes, or the picker it opens. */
function StatusSheet({ open, part, onClose }: { open: OpenView; part: StatusPart; onClose(): void }): React.JSX.Element {
  const { live, session } = open
  const [error, setError] = useState<string | null>(null)
  const pick = (p: Promise<unknown>): void => void p.then(onClose, (e: unknown) => setError(errorText(e)))
  if (part !== 'usage') {
    const choice = part === 'model' ? live.model : part === 'effort' ? live.effort : live.modes
    const title = part === 'model' ? 'Model' : part === 'effort' ? 'Effort' : 'Permissions'
    return (
      <Sheet title={title} onClose={onClose}>
        {error && <p className="m-error" role="alert">{error}</p>}
        {choice?.options.map((o) => (
          <button key={o.value} className={`m-opt${o.value === choice.current ? ' on' : ''}`} onClick={() => pick(
            part === 'mode' ? window.gloss.sessions.setMode(session.id, o.value) : window.gloss.sessions.setChoice(session.id, part, o.value)
          )}>
            <span className="m-opt-text">
              <b>{part === 'model' && o.value === 'default' && o.description ? choiceName({ current: o.value, options: [o] }) : o.name}</b>
              {o.description && !(part === 'model' && o.value === 'default') && <small>{o.description}</small>}
            </span>
            {o.value === choice.current && <Check size={18} />}
          </button>
        ))}
      </Sheet>
    )
  }
  return <UsageSheet open={open} onClose={onClose} />
}

/**
 * The desktop's usage popup on the phone: context, then the plan limits the agent reports when
 * asked (with percentages, which its live updates leave out far from a limit), extra usage and cost.
 */
function UsageSheet({ open, onClose }: { open: OpenView; onClose(): void }): React.JSX.Element {
  const { live, session } = open
  const [plan, setPlan] = useState<PlanUsage | null>(null)
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setState('loading')
    window.gloss.sessions.planUsage(session.id).then(
      (value) => { if (active) { setPlan(value); setState('done') } },
      () => { if (active) setState('error') }
    )
    return () => { active = false }
  }, [session.id, attempt])
  return (
    <Sheet title={plan?.plan ? `Usage · ${plan.plan}` : 'Usage'} onClose={onClose}>
      {live.usage && live.usage.size > 0 && (
        <Meter label="Context" percent={(live.usage.used / live.usage.size) * 100} detail={`${fmt(live.usage.used)} of ${fmt(live.usage.size)} tokens`} />
      )}
      {state === 'loading' && <p className="m-small m-sheet-note" role="status">Loading plan usage…</p>}
      {state === 'error' && (
        <p className="m-small m-sheet-note" role="alert">Couldn&apos;t load plan usage. <button className="m-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
      )}
      {state === 'done' && (!plan || !plan.available) && <p className="m-small m-sheet-note">Plan limits are unavailable for this account.</p>}
      {plan?.available && plan.limits.map((l) => (
        <Meter key={l.label} label={l.label} percent={l.percent} detail={l.resetsAt === null ? undefined : resetIn(l.resetsAt)} />
      ))}
      {plan?.available && plan.extraUsage && (plan.extraUsage.percent === null
        ? <p className="m-small m-sheet-note">Extra usage enabled</p>
        : <Meter label="Extra usage" percent={plan.extraUsage.percent} />)}
      {live.usage?.cost && <div className="m-kv"><span className="m-k">Session cost</span><span className="m-v">{live.usage.cost.currency === 'USD' ? '$' : ''}{live.usage.cost.amount.toFixed(2)}</span></div>}
    </Sheet>
  )
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail?: string }): React.JSX.Element {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div className={`m-kv m-col m-meter-row${percent >= 100 ? ' full' : percent >= 80 ? ' high' : ''}`}>
      <div className="m-row-flex"><span className="m-k">{label}</span><span className="m-v">{Math.round(percent)}%</span></div>
      <div className="m-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><i style={{ width: `${value}%` }} /></div>
      {detail && <span className="m-small m-meter-detail">{detail}</span>}
    </div>
  )
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// Threads and queue

function ThreadsList({ open, onBack, onOpen }: { open: OpenView; onBack(): void; onOpen(t: Thread): void }): React.JSX.Element {
  const [tab, setTab] = useState<'threads' | 'queue'>('threads')
  const threads = open.threads.filter((t) => t.anchor.kind !== 'line' && !t.finding)
  const replies = (t: Thread) => open.messages.filter((m) => m.threadId === t.id).length
  const last = (t: Thread) => Math.max(t.createdAt, ...open.messages.filter((m) => m.threadId === t.id).map((m) => m.createdAt ?? 0))
  const nameOf = (id: string | null) => id === null ? 'Main conversation' : threadName(threads.find((t) => t.id === id) ?? ({ anchor: { kind: 'selection', start: 0, end: 0, text: 'Thread' } } as Thread))
  return (
    <>
      <div className="m-hdr">
        <button className="m-back" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="m-hdr-t"><b>Threads</b><small>{open.session.title}</small></div>
      </div>
      <div className="m-tabs">
        <button aria-pressed={tab === 'threads'} onClick={() => setTab('threads')}>Threads {threads.length}</button>
        <button aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>Queue {open.queue.items.length}</button>
      </div>
      <div className="m-body m-scroll">
        {tab === 'threads' ? (
          threads.length === 0 ? <p className="m-empty">No threads yet. Tap a list item or paragraph, or select text, to reply in a thread.</p>
            : threads.map((t) => {
              const queued = open.queue.items.filter((q) => q.threadId === t.id).length
              return (
                <button key={t.id} className="m-row" onClick={() => onOpen(t)}>
                  <span className="m-row-main">
                    <b className="m-wrap">{threadName(t)}</b>
                    <small>
                      {open.turn?.threadId === t.id && <><span className="m-dot m-pulse s-working" />working ·</>}
                      {queued > 0 && <span className={open.queue.paused ? 's-paused' : 's-queued'}>{queued} queued{open.queue.paused ? ', paused' : ''} ·</span>}
                      {replies(t)} {replies(t) === 1 ? 'reply' : 'replies'}
                    </small>
                  </span>
                  <span className="m-when">{when(last(t))}</span>
                </button>
              )
            })
        ) : (
          <>
            {open.queue.paused && open.queue.items.length > 0 && (
              <div className="m-qhead paused m-pad"><span className="m-grow">Queue paused</span>
                <button className="m-resume" onClick={() => void window.gloss.queue.resume(open.session.id)}>Resume</button>
              </div>
            )}
            {open.queue.items.length === 0 && <p className="m-empty">Nothing is queued.</p>}
            {open.queue.items.slice().reverse().map((q) => (
              <div key={q.id} className="m-row">
                <span className="m-row-main"><small>{nameOf(q.threadId)}</small><b className="m-wrap">{q.text}</b></span>
                <button className="m-ib sm" aria-label="Remove" onClick={() => void window.gloss.queue.remove(open.session.id, q.id)}><Trash2 size={14} /></button>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

// Bits

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <div className="m-dim" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-label={title}>
        <div className="m-grab" />
        <h4>{title}</h4>
        {children}
      </div>
    </>
  )
}

