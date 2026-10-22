// Screen capture for visual feedback (SPEC → Visual feedback): the contract between the main
// process, the region overlay and the main window. Type-only, plus channel names.

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
}

/** What the user picked in the overlay; null cancels. */
export type CaptureChoice = { rect: CaptureRect; kind: 'region' | 'window' | 'display'; title?: string } | null

/** A finished capture, for the annotation canvas. */
export type Capture = {
  /** PNG, base64. */
  data: string
  width: number
  height: number
  /** What was captured, for the canvas's header: "Region", "Display" or "Window: <title>". */
  source: string
}

/** The overlay's preload API. */
export type CaptureOverlayApi = {
  frame(): Promise<CaptureFrame>
  done(choice: CaptureChoice): Promise<void>
}

/** The overlay's channels. The main window's `capture.start` is in IPC (shared/ipc.ts), so the two preloads share no module. */
export const CAPTURE_IPC = {
  frame: 'gloss:capture:frame',
  done: 'gloss:capture:done'
} as const
