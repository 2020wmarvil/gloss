// Drag handles that resize the sidebar and the thread panel. Widths are UI state,
// not settings: they are remembered in localStorage.
import { useEffect, useState } from 'react'

export type WidthLimits = { min: number; max: number }

/** The CSS default widths, used until the user resizes a pane. */
export const SIDEBAR_DEFAULT = 240
/** The collapsed sidebar's rail, and the collapsed side panel's. */
export const SIDEBAR_RAIL = 44
export const SIDE_RAIL = 44
const SIDEBAR_MIN = 180
const THREAD_PANEL_MIN = 320
/** The narrowest the conversation gets while the window has room for it. */
const CONVERSATION_MIN = 360

export function clampWidth(width: number, limits: WidthLimits): number {
  return Math.round(Math.min(Math.max(width, limits.min), Math.max(limits.min, limits.max)))
}

/** `side`: the thread panel's width while it is open, null when it is a rail, undefined when there is none. */
export function sidebarLimits(windowWidth: number, side?: number | null): WidthLimits {
  const others = side === undefined ? 0 : side === null ? SIDE_RAIL : THREAD_PANEL_MIN
  return { min: SIDEBAR_MIN, max: Math.min(480, Math.round(windowWidth * 0.4), windowWidth - others - CONVERSATION_MIN) }
}

export function threadPanelLimits(windowWidth: number, sidebarWidth: number): WidthLimits {
  return { min: THREAD_PANEL_MIN, max: windowWidth - sidebarWidth - CONVERSATION_MIN }
}

/** The thread panel's width until it is dragged: it grows with the window (the CSS default). */
export function threadPanelDefault(windowWidth: number): number {
  return clampWidth(windowWidth * 0.32, { min: 420, max: 600 })
}

/**
 * The widths the panes get in this window. null = shown as a rail; for the side
 * panel, undefined = there is none (no session open, or settings).
 */
export type PaneWidths = { sidebar: number | null; side: number | null | undefined }

/**
 * Fits the panes around a conversation of at least 360px: the thread panel gives up
 * width first (down to 320px), then the sidebar (down to 180px). When both are open
 * and that isn't enough, the one not in `keep` (the one opened last) collapses to its
 * rail, until the window is wide enough again.
 */
export function fitPanes(windowWidth: number, wanted: PaneWidths, keep: 'sidebar' | 'side'): PaneWidths {
  function squeeze(sidebar: number | null, side: number | null | undefined): PaneWidths & { fits: boolean } {
    const used = (sidebar ?? SIDEBAR_RAIL) + (side === undefined ? 0 : (side ?? SIDE_RAIL))
    let over = CONVERSATION_MIN - (windowWidth - used)
    if (over > 0 && typeof side === 'number') {
      const cut = Math.min(over, Math.max(0, side - THREAD_PANEL_MIN))
      side -= cut
      over -= cut
    }
    if (over > 0 && sidebar !== null) {
      const cut = Math.min(over, Math.max(0, sidebar - SIDEBAR_MIN))
      sidebar -= cut
      over -= cut
    }
    return { sidebar, side, fits: over <= 0 }
  }
  let fitted = squeeze(wanted.sidebar, wanted.side)
  if (!fitted.fits && wanted.sidebar !== null && typeof wanted.side === 'number') {
    fitted = keep === 'side' ? squeeze(null, wanted.side) : squeeze(wanted.sidebar, null)
  }
  return { sidebar: fitted.sidebar, side: fitted.side }
}

/** A pane width remembered across restarts; null = the pane's CSS default. */
export function useStoredWidth(key: string): [number | null, (width: number | null) => void] {
  const [width, setWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  })
  function set(next: number | null): void {
    setWidth(next)
    if (next === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(Math.round(next)))
  }
  return [width, set]
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

type HandleProps = {
  label: string
  /**
   * Where the pane is: 'before' = the handle's previous sibling (the sidebar),
   * 'after' = its next sibling (the thread panel). Dragging away from the pane widens it.
   */
  pane: 'before' | 'after'
  limits: WidthLimits
  /** The pane's width if the user has set one. */
  value: number | null
  onResize(width: number): void
  /** Back to the CSS default (double-click). */
  onReset(): void
}

const KEY_STEP = 16

/** A vertical separator on a pane's inner edge: drag it, or focus it and use the arrow keys. */
export function ResizeHandle(props: HandleProps): React.JSX.Element {
  const { pane, limits } = props
  const [dragging, setDragging] = useState(false)
  const sign = pane === 'before' ? 1 : -1

  function paneWidth(handle: HTMLElement): number | null {
    const el = pane === 'before' ? handle.previousElementSibling : handle.nextElementSibling
    return el ? el.getBoundingClientRect().width : null
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    const handle = e.currentTarget
    const startWidth = paneWidth(handle)
    if (startWidth === null) return
    e.preventDefault()
    const startX = e.clientX
    handle.setPointerCapture(e.pointerId)
    setDragging(true)
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent): void => props.onResize(clampWidth(startWidth + sign * (ev.clientX - startX), limits))
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setDragging(false)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const width = paneWidth(e.currentTarget)
    if (width === null) return
    e.preventDefault()
    const step = (e.key === 'ArrowRight' ? 1 : -1) * sign * KEY_STEP
    props.onResize(clampWidth(width + step, limits))
  }

  return (
    <div
      className={`resize-handle${dragging ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={limits.min}
      aria-valuemax={Math.max(limits.min, limits.max)}
      aria-valuenow={props.value ?? undefined}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={props.onReset}
    />
  )
}
