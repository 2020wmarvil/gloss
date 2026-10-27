// Screen capture for visual feedback (SPEC → Visual feedback): the contract between the main
// process, the region overlay, the annotation window and the window that asked. Type-only, plus
// channel names.
import type { Attachment, Pin } from './types'

/** A rectangle in a display's pixels (physical, not DIPs), from its top left. */
export type CaptureRect = { x: number; y: number; width: number; height: number }

/** A top-level window on the display, for hover-and-click capture. Topmost first. */
export type CaptureWindow = { title: string; rect: CaptureRect }

/** What the overlay draws: the frozen display, in its pixels, and the windows on it. */
export type CaptureFrame = {
  png: Uint8Array
  width: number
  height: number
  /** Display pixels per CSS pixel of the overlay. */
  scale: number
  windows: CaptureWindow[]
  /** Where the cursor was, when it was on this display. */
  cursor?: { x: number; y: number }
}

/** What the user picked in the overlay; null cancels. */
export type CaptureChoice = { rect: CaptureRect; kind: 'region' | 'window' | 'display'; title?: string } | null

/** A finished capture, for the annotation canvas. */
export type Capture = {
  /** Base64: a PNG, unless `mimeType` says otherwise (an attached image being annotated). */
  data: string
  mimeType?: string
  width: number
  height: number
  /** What was captured, for the canvas's header: "Region", "Display" or "Window: <title>". */
  source: string
}

/** A drawn mark, in the capture's pixels. */
export type Shape =
  | { type: 'pen' | 'highlighter'; color: string; points: [number, number][] }
  | { type: 'box' | 'arrow'; color: string; x1: number; y1: number; x2: number; y2: number }

/** A capture being annotated, kept so the composer can reopen it (Edit) until it is sent. */
export type Annotation = { capture: Capture; shapes: Shape[]; pins: Pin[] }

/** What an annotation window opens with: `retake` offers Retake (a capture, not an attached image). */
export type AnnotateRequest = { annotation: Annotation; retake: boolean }

/** What the annotation window hands back: the flattened image and its annotation; null if closed. */
export type AnnotateResult = { image: Extract<Attachment, { kind: 'image' }>; annotation: Annotation } | null

/** The overlay's preload API. */
export type CaptureOverlayApi = {
  frame(): Promise<CaptureFrame>
  done(choice: CaptureChoice): Promise<void>
  /** The cursor came onto this overlay's display: it takes the keys. */
  enter(): void
}

/** The overlay's channels. The main window's `capture.start` is in IPC (shared/ipc.ts), so the two preloads share no module. */
export const CAPTURE_IPC = {
  frame: 'gloss:capture:frame',
  done: 'gloss:capture:done',
  enter: 'gloss:capture:enter'
} as const
