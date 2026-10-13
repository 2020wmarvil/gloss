// Drag handles that resize the sidebar and the thread panel. Widths are UI state,
// not settings: they are remembered in localStorage.
import { useEffect, useState } from 'react'

export type WidthLimits = { min: number; max: number }

/** The CSS default widths, used until the user resizes a pane. */
export const SIDEBAR_DEFAULT = 240
/** The narrowest the conversation gets when a pane is dragged wide. */
const CONVERSATION_MIN = 360

export function clampWidth(width: number, limits: WidthLimits): number {
  return Math.round(Math.min(Math.max(width, limits.min), Math.max(limits.min, limits.max)))
}

export function sidebarLimits(windowWidth: number): WidthLimits {
  return { min: 180, max: Math.min(480, Math.round(windowWidth * 0.4)) }
}

export function threadPanelLimits(windowWidth: number, sidebarWidth: number): WidthLimits {
  return { min: 320, max: windowWidth - sidebarWidth - CONVERSATION_MIN }
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
