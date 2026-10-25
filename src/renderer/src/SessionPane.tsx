// The open session's view: the conversation or review in the center and the side panel,
// in the main window or in the session's own window (SPEC → Session windows).
import { useEffect, useMemo, useState } from 'react'
import type { SettingsState } from '@shared/ipc'
import { projectSettings } from '@shared/settings'
import type { AgentInfo, Session, Thread } from '@shared/types'
import { SquareArrowOutDownLeft, SquareArrowOutUpRight } from 'lucide-react'
import { Conversation } from './Conversation'
import { GeneralPanel, ReviewThreadList } from './ReviewPanels'
import { locations as threadLocations } from './reviewThreads'
import { useReviewSources } from './reviewSources'
import { ReviewView } from './ReviewView'
import { ResizeHandle, type WidthLimits } from './resize'
import { modKey } from './shortcuts'
import { ThreadPanel } from './ThreadPanel'
import { SideRail, ThreadsOverview } from './ThreadsOverview'
import { errorText } from './errors'
import { threadName, type OpenSession, type SessionState } from './useSession'

const NO_THREADS: Thread[] = []

/** "Press F11 to exit full screen", shown for a few seconds after entering it. */
export function FullScreenHint(): React.JSX.Element | null {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), 3000)
    return () => clearTimeout(timer)
  }, [])
  if (!shown) return null
  return (
    <div className="fullscreen-hint" role="status">
      Press <kbd>F11</kbd> to exit full screen
    </div>
  )
}

/**
 * What the collapsed side panel counts: a session's threads, or for a review its open
 * line threads plus the general conversation, which the panel also holds.
 */
function sideRailCount(open: OpenSession, isReview: boolean): { count: number; label?: string } {
  if (!isReview) return { count: open.threads.length }
  const threads = open.threads.filter((t) => t.anchor.kind === 'line' && t.resolvedAt === undefined).length
  return {
    count: threads + 1,
    label: `the general conversation and ${threads} open ${threads === 1 ? 'thread' : 'threads'}`
  }
}

/** Pop out (in the main window), or Return to main window (in a session window), at the end of the session header. */
export function WindowButton(props: { popped: boolean; onClick(): void }): React.JSX.Element {
  const label = props.popped ? 'Return to main window' : 'Pop out'
  return (
    <button
      className="tool-button icon window-button"
      title={`${props.popped ? 'Return to main window' : 'Pop out into its own window'} (${modKey()}+Shift+O)`}
      aria-label={label}
      onClick={props.onClick}
    >
      {props.popped ? <SquareArrowOutDownLeft /> : <SquareArrowOutUpRight />}
    </button>
  )
}

type Props = {
  s: SessionState
  open: OpenSession
  settings: SettingsState | null
  agents: AgentInfo[]
  sent: string[]
  /** The side panel is expanded, at this width. */
  sideShown: boolean
  threadWidth: number | null
  threadLimit: WidthLimits
  onResizeThread(width: number | null): void
  creating: boolean
  onNewReview(from: Session): void
  /** This view is in the session's own window. */
  popped: boolean
  /** Pops the session out, or returns it to the main window. */
  onWindow(): void
}

export function SessionPane(props: Props): React.JSX.Element {
  const { s, open, settings, agents, sent, sideShown, threadWidth } = props
  const { isReview, diffState, live, queue, runningThread, sessionNotices, panel, reveal } = s
  const shown = s.openShown ?? open
  const id = open.session.id
  /** The panel's thread while it is expanded. */
  const shownPanel = sideShown ? panel : null
  const reviewSources = useReviewSources(isReview ? id : null, open.session.review, diffState.diff, open.threads ?? NO_THREADS)
  const lineLocations = useMemo(
    () => threadLocations(open.threads, diffState.diff, reviewSources.sources),
    [open.threads, diffState.diff, reviewSources.sources]
  )
  const agentName = agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId
  const obsidianVault = settings ? projectSettings(settings.projects, open.session.cwd).obsidianVault : undefined
  const windowButton = <WindowButton popped={props.popped} onClick={props.onWindow} />
  const exportMarkdown = (threadId: string | null, how: 'copy' | 'save'): void => {
    const done = how === 'copy' ? window.gloss.sessions.copyMarkdown(id, threadId) : window.gloss.sessions.saveMarkdown(id, threadId)
    done.catch((err: unknown) => s.addNotice(id, threadId, `Couldn't export: ${errorText(err)}`))
  }

  return (
    <>
      {isReview ? (
        <ReviewView
          obsidianVault={obsidianVault}
          key={id}
          open={shown}
          agentName={agentName}
          diff={diffState}
          locations={lineLocations}
          sources={reviewSources.sources}
          onReadSource={reviewSources.read}
          panel={shownPanel}
          runningThread={runningThread}
          live={live}
          git={s.git}
          pr={s.pr}
          queue={queue}
          onResumeQueue={() => void window.gloss.queue.resume(id)}
          onSetChoice={(kind, value) => window.gloss.sessions.setChoice(id, kind, value)}
          onCommand={(text) => void s.send(text, [], null)}
          onOpenThread={s.openThread}
          onReplyLines={s.openLines}
          creating={props.creating}
          onRunReview={() => s.runReview(id)}
          onNewReview={() => props.onNewReview(open.session)}
          windowButton={windowButton}
          initialExpandedFiles={s.takeExpanded(id)}
          onExpandedFilesChange={(files) => {
            s.expandedFiles.current = files
          }}
          onOpenFile={(path, how, line) => {
            window.gloss.sessions.openReviewFile(id, path, how, line).catch((err: unknown) => s.addNotice(id, null, errorText(err)))
          }}
          onSetRange={(range) => {
            window.gloss.sessions.setReviewRange(id, range.baseRef, range.headRef ?? null).then(
              (diff) => s.showDiff(id, diff),
              (err: unknown) => s.addNotice(id, null, errorText(err))
            )
          }}
        />
      ) : (
        <Conversation
          obsidianVault={obsidianVault}
          key={id}
          open={shown}
          listItemReplies={settings?.global.listItemReplies ?? false}
          agentName={agentName}
          live={live}
          history={sent}
          git={s.git}
          pr={s.pr}
          runningThread={runningThread}
          lastThread={s.lastThread}
          notices={sessionNotices}
          panel={shownPanel}
          reveal={reveal}
          queue={queue}
          composerQueue={s.composerQueue(id, queue.items.filter((q) => q.threadId === null))}
          windowButton={windowButton}
          onSend={(text, attachments) => void s.send(text, attachments, null)}
          onSteer={(text, attachments) => void s.send(text, attachments, null, 'steer')}
          onCancel={() => void window.gloss.cancel(id)}
          onSetChoice={(kind, value) => window.gloss.sessions.setChoice(id, kind, value)}
          onOpenItem={s.openItem}
          onOpenSelection={s.openSelection}
          onOpenPin={s.openPin}
          onOpenThread={s.openThread}
          onOpenMain={() => s.focusComposer(true)}
          onOpenQueue={s.showQueue}
        />
      )}
      {!sideShown && <SideRail {...sideRailCount(open, isReview)} onExpand={s.openSide} />}
      {sideShown && (
        <>
          <ResizeHandle
            label="Resize side panel"
            pane="after"
            limits={props.threadLimit}
            value={threadWidth}
            onResize={props.onResizeThread}
            onReset={() => props.onResizeThread(null)}
          />
          {isReview && s.general && !panel ? (
            <GeneralPanel
              width={threadWidth}
              open={shown}
              notices={sessionNotices}
              reveal={reveal}
              live={live}
              history={sent}
              runningThread={runningThread}
              queue={s.composerQueue(id, queue.items.filter((q) => q.threadId === null))}
              onSend={(text, attachments) => void s.send(text, attachments, null)}
              onSteer={(text, attachments) => void s.send(text, attachments, null, 'steer')}
              onCancel={() => void window.gloss.cancel(id)}
              onRunReview={() => s.runReview(id)}
              onBack={() => s.setPanel(null)}
              onClose={s.collapseSide}
              onOpenThread={s.openThread}
            />
          ) : panel ? (
            <ThreadPanel
              location={panel.threadId !== null ? lineLocations.get(panel.threadId) : undefined}
              onResolve={(threadId, resolved) =>
                void window.gloss.threads.resolve(id, threadId, resolved).catch((err: unknown) => s.addNotice(id, threadId, errorText(err)))
              }
              width={threadWidth}
              open={shown}
              panel={panel}
              reveal={reveal}
              backTo={s.sideTab}
              runningThread={runningThread}
              notices={sessionNotices}
              live={live}
              history={sent}
              // A thread that doesn't exist yet has nothing queued.
              queue={s.composerQueue(id, panel.threadId === null ? [] : queue.items.filter((q) => q.threadId === panel.threadId))}
              onSend={(text, attachments) => void s.send(text, attachments, panel)}
              onSteer={(text, attachments) => void s.send(text, attachments, panel, 'steer')}
              onSendToMain={(text, attachments) => void s.send(text, attachments, null, 'send', panel.threadId)}
              onCancel={() => void window.gloss.cancel(id)}
              onBack={() => s.setPanel(null)}
              onClose={s.collapseSide}
              onOpenPin={s.openPin}
              onCopyMarkdown={(threadId) => exportMarkdown(threadId, 'copy')}
              onSaveMarkdown={(threadId) => exportMarkdown(threadId, 'save')}
              // A review's conversation is in the General panel, which this panel replaces.
              onFindInMain={panel.anchorMessageId !== null && !isReview ? () => s.findInMain(panel) : undefined}
              onRevealMain={s.revealMessage}
            />
          ) : (
            <ThreadsOverview
              width={threadWidth}
              open={shown}
              tab={s.sideTab}
              onTab={s.setSideTab}
              runningThread={runningThread}
              queue={queue}
              name={threadName}
              onOpenThread={s.openThread}
              onFindInMain={
                isReview ? undefined : (t) => s.findInMain({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
              }
              onReveal={s.revealMessage}
              onOpenMain={() => {
                if (isReview) s.openGeneral()
                s.focusComposer(true)
              }}
              onEditQueued={(itemId, text) => window.gloss.queue.edit(id, itemId, text)}
              onRemoveQueued={(itemId) => window.gloss.queue.remove(id, itemId)}
              onResumeQueue={() => window.gloss.queue.resume(id)}
              onCollapse={s.collapseSide}
              review={
                isReview
                  ? {
                      count: open.threads.filter((t) => t.anchor.kind === 'line').length,
                      content: (
                        <ReviewThreadList
                          open={shown}
                          diff={diffState.diff}
                          locations={lineLocations}
                          runningThread={runningThread}
                          queue={queue}
                          onOpenThread={s.openThread}
                          onOpenGeneral={s.openGeneral}
                        />
                      )
                    }
                  : undefined
              }
            />
          )}
        </>
      )}
    </>
  )
}
