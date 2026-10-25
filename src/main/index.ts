import { readFileSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, screen, shell, type WebContents } from 'electron'
import { IPC, type AppBadge, type GlossEvent, type MainAction, type PaneState } from '../shared/ipc'
import type { Anchor, Attachment, Pin } from '../shared/types'
import type { AnswerValue, RequestAnswer } from '../shared/requests'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, listAgents } from './agents'
import { Store } from './db'
import type { SearchRequest } from '../shared/search'
import { toMarkdown } from './export'
import { gitStatus, pullRequest } from './git'
import { SessionManager } from './sessions'
import { BADGE_LABEL, BADGE_SIZE, badgePixels } from './badge'
import { patchArg, SettingsFile } from './settings'
import { editorArgs, launchEditor } from './openFile'
import { fileLink } from '../shared/fileLink'
import { readMarkdownImage } from './markdownImage'
import { registerComposerIpc } from './composerIpc'
import { takeForeground } from './foreground'
import { runInTerminal } from './terminal'
import { registerCaptureIpc, startCapture } from './capture'
import { normalizeShortcut, shortcutLabel } from '../shared/shortcut'
import { UsageSource } from './usage'
import { DEFAULT_CAPTURE_SHORTCUT, DEFAULT_EXTERNAL_EDITOR, projectSettings } from '../shared/settings'
import { obsidianUri } from '../shared/obsidian'
import { previewMcpImport } from './mcp-import'
import { OpenCodeSupport } from './opencode'
import { AgentProfileSupport } from './agentProfiles'
import { profileError, type AgentProfile } from '../shared/agentProfiles'
import { boundsArg, placeSessionWindow, type Rect } from './windowPlacement'
import iconIco from '../../build/icon.ico?asset'
import iconPng from '../../build/icons/256x256.png?asset'

let mainWindow: BrowserWindow | undefined
let store: Store | undefined
let sessions: SessionManager | undefined
let settings: SettingsFile | undefined
let openCode: OpenCodeSupport
let openCodeRestartPending = false
let profileSupport: AgentProfileSupport
const appliedProfiles = new Map<string, AgentProfile>()
const pendingProfiles = new Set<string>()
let applyingProfiles = false

async function applyProfileChanges(): Promise<void> {
  if (applyingProfiles) return
  applyingProfiles = true
  try {
    for (const id of pendingProfiles) {
      if (!sessions || !await sessions.restartIdleAgent(id, true)) continue
      const profile = settings?.state().global.agentProfiles?.find((p) => p.id === id)
      if (profile) appliedProfiles.set(id, profile)
      else appliedProfiles.delete(id)
      pendingProfiles.delete(id)
    }
  } finally {
    applyingProfiles = false
  }
}
const usage = new UsageSource()

function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

// The renderer draws the title bar (SPEC → Title bar); the system's window controls sit
// over its right end (the traffic lights over its left on macOS), in its colors.
const TITLE_BAR_HEIGHT = 40

/**
 * The window controls' colors: styles.css's --title-bar and --ink for the theme in use.
 * Their hover tint comes from Chromium's native theme, which follows the theme setting
 * (themeSource), so it contrasts with them.
 */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#0c0b0a', symbolColor: '#efeee9', height: TITLE_BAR_HEIGHT }
    : { color: '#ebeae4', symbolColor: '#1c1b18', height: TITLE_BAR_HEIGHT }
}

function updateTitleBar(): void {
  if (process.platform !== 'darwin') for (const win of glossWindows()) win.setTitleBarOverlay(titleBarOverlay())
}

/** Session id → the window it is popped out into (SPEC → Session windows). */
const sessionWindows = new Map<string, BrowserWindow>()
/** Each session window's session and the state it opened with, by its webContents id. */
const windowStates = new Map<number, { sessionId: string; state: PaneState }>()
/** The Gloss window focused last: its composer used last takes a capture. */
let lastFocused: BrowserWindow | undefined

/** The main window and the session windows (not capture overlays). */
function glossWindows(): BrowserWindow[] {
  return [mainWindow, ...sessionWindows.values()].filter((w): w is BrowserWindow => w !== undefined && !w.isDestroyed())
}

function isGlossSender(sender: WebContents): boolean {
  return glossWindows().some((w) => w.webContents === sender)
}

/** The session a session window holds, by its webContents. */
function windowSession(sender: WebContents): string | undefined {
  for (const [id, win] of sessionWindows) if (!win.isDestroyed() && win.webContents === sender) return id
  return undefined
}

function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** A Gloss window: the title bar, icon, security settings and navigation guards every one has. */
function newWindow(bounds: Partial<Rect> & { width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Gloss',
    titleBarStyle: 'hidden',
    // On macOS `true` only turns on the titlebar-area CSS variables the title bar lays out with.
    titleBarOverlay: process.platform === 'darwin' ? true : titleBarOverlay(),
    trafficLightPosition: { x: 14, y: 13 },
    // Windows takes every size from the .ico; macOS uses the app bundle's icon instead.
    icon: process.platform === 'win32' ? iconIco : iconPng,
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.on('focus', () => {
    lastFocused = win
  })
  // The renderer shows how to leave full screen; macOS shows its own controls.
  if (process.platform !== 'darwin') {
    win.on('enter-full-screen', () => win.webContents.send(IPC.event, { type: 'fullScreen' } satisfies GlossEvent))
  }
  if (process.platform !== 'darwin') {
    win.webContents.on('before-input-event', (event, input) => {
      if (handleShortcut(win, input)) event.preventDefault()
    })
  }

  // Agent output is untrusted. Never open new windows or navigate away from the
  // app; send web links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  return win
}

function createWindow(): void {
  const win = newWindow({ width: 1280, height: 820 })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
    // Closing the main window quits Gloss, session windows included.
    for (const w of sessionWindows.values()) if (!w.isDestroyed()) w.close()
  })
  loadPage(win, 'index.html')
}

/** The last session window's size and position (SPEC → Session windows → Restart). */
function boundsFile(): string {
  return join(app.getPath('userData'), 'session-window.json')
}

function savedBounds(): Rect | null {
  try {
    return boundsArg(JSON.parse(readFileSync(boundsFile(), 'utf8')))
  } catch {
    return null
  }
}

let boundsTimer: ReturnType<typeof setTimeout> | undefined
function saveBounds(win: BrowserWindow, now = false): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  const bounds = win.getNormalBounds()
  clearTimeout(boundsTimer)
  const write = (): void => void writeFile(boundsFile(), JSON.stringify(bounds)).catch(() => {})
  if (now) write()
  else boundsTimer = setTimeout(write, 500)
}

/** Tells every window which sessions are popped out, and whose window is focused. */
function sendWindows(): void {
  const focused = [...sessionWindows].find(([, w]) => !w.isDestroyed() && w.isFocused())?.[0] ?? null
  emit({ type: 'windows', popped: [...sessionWindows.keys()], focused })
}

/** Pops a session out into its own window, where it opens with `state` (SPEC → Session windows). */
function openSessionWindow(sessionId: string, state: PaneState): void {
  const home = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea
  const bounds = placeSessionWindow(
    savedBounds(),
    [...sessionWindows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getBounds()),
    screen.getAllDisplays().map((d) => d.workArea),
    home
  )
  const win = newWindow(bounds)
  const contentsId = win.webContents.id
  sessionWindows.set(sessionId, win)
  windowStates.set(contentsId, { sessionId, state })
  win.on('focus', sendWindows)
  win.on('blur', sendWindows)
  win.on('moved', () => saveBounds(win))
  win.on('resized', () => saveBounds(win))
  win.on('close', () => saveBounds(win, true))
  win.on('closed', () => {
    windowStates.delete(contentsId)
    if (sessionWindows.get(sessionId) === win) sessionWindows.delete(sessionId)
    if (lastFocused === win) lastFocused = undefined
    sendWindows()
  })
  loadPage(win, 'index.html', { session: sessionId })
  sendWindows()
}

/** Loads one of the renderer's pages: from the dev server in development, else from the build. */
function loadPage(win: BrowserWindow, page: 'index.html' | 'capture.html', query?: Record<string, string>): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    const url = new URL(page, devUrl.endsWith('/') ? devUrl : `${devUrl}/`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    void win.loadURL(url.href)
  } else {
    void win.loadFile(join(__dirname, '../renderer', page), query ? { query } : undefined)
  }
}

/**
 * The default menu's shortcuts, kept on Windows and Linux where Gloss has no menu:
 * zoom always, and DevTools and reload in development.
 */
function handleShortcut(win: BrowserWindow, input: Electron.Input): boolean {
  // AltGr arrives as Ctrl+Alt on Windows; leave it to typing.
  if (input.type !== 'keyDown' || input.alt) return false
  const mod = input.control
  const key = input.key.toLowerCase()
  const contents = win.webContents
  if (mod && (key === '=' || key === '+')) contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5))
  else if (mod && key === '-') contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3))
  else if (mod && key === '0') contents.setZoomLevel(0)
  // Full screen: a borderless window over the whole monitor. macOS has its own (Ctrl+Cmd+F).
  else if (!mod && !input.shift && key === 'f11') win.setFullScreen(!win.isFullScreen())
  else if (!app.isPackaged && (key === 'f12' || (mod && input.shift && key === 'i'))) contents.toggleDevTools()
  else if (!app.isPackaged && mod && key === 'r') contents.reload()
  else return false
  return true
}

/** Sessions with a turn running, and the sleep blocker held while there are any. */
const working = new Set<string>()
let awake: number | null = null

/** Keeps the computer from sleeping while an agent works (the display may still turn off). */
function keepAwake(event: GlossEvent): void {
  if (event.type === 'turnStart') working.add(event.sessionId)
  else if (event.type === 'turnEnd') working.delete(event.sessionId)
  else return
  if (working.size > 0 && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
  else if (working.size === 0 && awake !== null) {
    powerSaveBlocker.stop(awake)
    awake = null
  }
}

function emit(event: GlossEvent): void {
  if (event.type === 'reveal') {
    // A notification's session opens where it is: its own window, else the main one.
    ;(sessionWindows.get(event.sessionId) ?? mainWindow)?.webContents.send(IPC.event, event)
  } else if (event.type === 'captureShortcut') {
    const win = lastFocused && !lastFocused.isDestroyed() ? lastFocused : mainWindow
    win?.webContents.send(IPC.event, event)
  } else {
    for (const win of glossWindows()) win.webContents.send(IPC.event, event)
  }
  if (event.type === 'sessionDeleted') sessionWindows.get(event.sessionId)?.close()
  keepAwake(event)
  if (event.type === 'turnEnd') notifyTurnEnd(event)
  if (event.type === 'requests') notifyRequests(event)
  if (event.type === 'turnEnd' && openCodeRestartPending) {
    void sessions?.restartIdleAgent('opencode').then((restarted) => { if (restarted) openCodeRestartPending = false })
  }
  if (event.type === 'turnEnd' && pendingProfiles.size) void applyProfileChanges()
}

/** The capture shortcut (SPEC → Visual feedback): the setting, what is registered now, and why it isn't. */
const capture = { setting: '', registered: null as string | null, error: null as string | null, paused: false }

/**
 * Registers the setting's capture shortcut in place of the last one. It is the only one, and works
 * whether Gloss or another app is in front: the renderer starts a capture for the composer used
 * last. Empty turns it off. Another app holding the keys leaves none registered, with the reason
 * kept for the settings screen. While the settings screen records a new one it is paused, or the
 * keys would start a capture instead of reaching it.
 */
function setCaptureShortcut(accelerator: string | undefined): void {
  if (capture.registered) globalShortcut.unregister(capture.registered)
  capture.registered = null
  capture.error = null
  capture.setting = (accelerator ?? '').trim()
  if (!capture.setting || capture.paused) return
  const keys = normalizeShortcut(capture.setting)
  if (!keys) {
    capture.error = `${capture.setting} isn't a key combination Gloss can use.`
    return
  }
  try {
    if (globalShortcut.register(keys, () => emit({ type: 'captureShortcut' }))) capture.registered = keys
    else capture.error = `Another app is already using ${shortcutLabel(keys, process.platform === 'darwin')}.`
  } catch {
    capture.error = `${capture.setting} isn't a key combination Gloss can use.`
  }
}

/** Shown notifications, kept so their click handlers survive garbage collection. */
const notifications = new Set<Notification>()

/** An OS notification when a turn ends or fails while Gloss isn't focused. Clicking it opens the session (and thread). */
function notifyTurnEnd(event: Extract<GlossEvent, { type: 'turnEnd' }>): void {
  // A queued message starting next isn't the end of the agent's work.
  if (glossWindows().some((w) => w.isFocused()) || event.stopReason === 'cancelled' || event.continues || !Notification.isSupported()) return
  const session = store?.getSession(event.sessionId)
  if (!session) return
  const body = event.error
    ? `The turn failed: ${event.error}`
    : event.threadId
      ? 'The agent replied in a thread.'
      : 'The agent finished.'
  // Gloss plays its own chime (or none, if the user turned it off) instead of the system's sound.
  const n = new Notification({ title: session.title, body, silent: true })
  notifications.add(n)
  n.on('click', () => {
    notifications.delete(n)
    const win = sessionWindows.get(event.sessionId) ?? mainWindow
    if (!win || win.isDestroyed()) return
    bringForward(win)
    emit({ type: 'reveal', sessionId: event.sessionId, threadId: event.threadId })
  })
  n.on('close', () => notifications.delete(n))
  n.show()
}

/** Per session, the open requests already notified about, so a changed list only notifies for new ones. */
const notifiedRequests = new Map<string, Set<string>>()

/** An OS notification when the agent starts waiting on the user while Gloss isn't focused (SPEC → Questions and approvals). */
function notifyRequests(event: Extract<GlossEvent, { type: 'requests' }>): void {
  const seen = notifiedRequests.get(event.sessionId)
  const fresh = event.requests.filter((r) => !seen?.has(r.id))
  notifiedRequests.set(event.sessionId, new Set(event.requests.map((r) => r.id)))
  const first = fresh[0]
  if (!first || glossWindows().some((w) => w.isFocused()) || !Notification.isSupported()) return
  const session = store?.getSession(event.sessionId)
  if (!session) return
  const body = first.kind === 'question' ? `Waiting for you: ${first.message}` : `Waiting for your approval: ${first.title}`
  const n = new Notification({ title: session.title, body, silent: true })
  notifications.add(n)
  n.on('click', () => {
    notifications.delete(n)
    const win = sessionWindows.get(event.sessionId) ?? mainWindow
    if (!win || win.isDestroyed()) return
    bringForward(win)
    emit({ type: 'reveal', sessionId: event.sessionId, threadId: first.threadId })
  })
  n.on('close', () => notifications.delete(n))
  n.show()
}

/**
 * Shows the renderer's badge: on Windows a dot over the taskbar icon, elsewhere the count
 * of unseen sessions where the OS has a badge (macOS, some Linux docks).
 */
function setBadge(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  const { state, unseen } = value as Partial<AppBadge>
  if (state !== null && state !== 'working' && state !== 'completed' && state !== 'failed') return
  if (process.platform !== 'win32') {
    app.setBadgeCount(typeof unseen === 'number' && unseen > 0 ? Math.floor(unseen) : 0)
    return
  }
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (state === null) return win.setOverlayIcon(null, '')
  const icon = nativeImage.createFromBitmap(badgePixels(state), { width: BADGE_SIZE, height: BADGE_SIZE, scaleFactor: 2 })
  win.setOverlayIcon(icon, BADGE_LABEL[state])
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${name} to be a string`)
  return value
}

function anchorArg(value: unknown): Anchor {
  const a = value as Partial<Record<string, unknown>> | null
  if (!a || typeof a.text !== 'string') throw new Error('Invalid anchor')
  if (a.kind === 'listItem' && Array.isArray(a.path) && a.path.every((n) => typeof n === 'number')) {
    return { kind: 'listItem', path: a.path as number[], text: a.text }
  }
  if (a.kind === 'selection' && typeof a.start === 'number' && typeof a.end === 'number') {
    return { kind: 'selection', start: a.start, end: a.end, text: a.text }
  }
  if (
    a.kind === 'line' &&
    typeof a.file === 'string' &&
    (a.side === 'old' || a.side === 'new') &&
    typeof a.start === 'number' &&
    typeof a.end === 'number' &&
    Array.isArray(a.lines) &&
    a.lines.every((l) => typeof l === 'string')
  ) {
    return { kind: 'line', file: a.file, side: a.side, start: a.start, end: a.end, text: a.text, lines: a.lines as string[] }
  }
  // The manager rebuilds a pin's anchor from its message; only which pin counts.
  if (a.kind === 'pin' && Number.isInteger(a.image) && Number.isInteger(a.pin)) {
    return { kind: 'pin', image: a.image as number, pin: a.pin as number, note: '', text: a.text }
  }
  throw new Error('Invalid anchor')
}

const MAX_ATTACHMENTS = 20
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_CHARS = 1024 * 1024

function attachmentsArg(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error('Invalid attachments')
  return value.map((v: unknown): Attachment => {
    const a = v as Partial<Record<string, unknown>> | null
    if (!a || typeof a.name !== 'string') throw new Error('Invalid attachment')
    if (
      a.kind === 'image' &&
      typeof a.mimeType === 'string' &&
      a.mimeType.startsWith('image/') &&
      typeof a.data === 'string' &&
      a.data.length <= (MAX_IMAGE_BYTES * 4) / 3 + 4
    ) {
      const pins = pinsArg(a.pins)
      return { kind: 'image', name: a.name, mimeType: a.mimeType, data: a.data, ...(pins ? { pins } : {}) }
    }
    if (a.kind === 'file' && typeof a.text === 'string') {
      if (a.text.length > MAX_FILE_CHARS) throw new Error(`${a.name} is too large to attach.`)
      return {
        kind: 'file',
        name: a.name,
        text: a.text,
        ...(typeof a.path === 'string' && a.path ? { path: a.path } : {}),
        ...(typeof a.mimeType === 'string' && a.mimeType ? { mimeType: a.mimeType } : {})
      }
    }
    throw new Error(`Invalid attachment ${a.name}`)
  })
}

const MAX_PINS = 99
const MAX_PIN_NOTE = 2000

/** An annotated screenshot's pins (SPEC → Visual feedback), or undefined for none. */
function pinsArg(value: unknown): Pin[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_PINS) throw new Error('Invalid pins')
  const pins = value.map((v: unknown): Pin => {
    const p = v as Partial<Record<string, unknown>> | null
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || typeof p.note !== 'string' || p.note.length > MAX_PIN_NOTE) {
      throw new Error('Invalid pin')
    }
    return { x: p.x as number, y: p.y as number, note: p.note }
  })
  return pins.length > 0 ? pins : undefined
}

/** A folder path: an empty one would make the agent list every project's sessions. */
function folderArg(value: unknown, name: string): string {
  const path = str(value, name)
  if (path.trim() === '') throw new Error(`Expected ${name} to be a folder path`)
  return path
}

/** Checks an answer from the renderer; the manager checks it against the request. */
function answerArg(value: unknown): RequestAnswer {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid answer')
  const a = value as Record<string, unknown>
  if (a.kind === 'permission') {
    if (a.cancelled === true) return { kind: 'permission', cancelled: true }
    return { kind: 'permission', optionId: str(a.optionId, 'optionId') }
  }
  if (a.kind === 'question') {
    if (a.action === 'decline' || a.action === 'cancel') return { kind: 'question', action: a.action }
    if (a.action === 'accept' && typeof a.content === 'object' && a.content !== null && !Array.isArray(a.content)) {
      const content: Record<string, AnswerValue> = {}
      for (const [k, v] of Object.entries(a.content)) {
        const ok = typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
          (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        if (!ok) throw new Error(`Invalid answer for ${k}`)
        content[k] = v as AnswerValue
      }
      return { kind: 'question', action: 'accept', content }
    }
  }
  throw new Error('Invalid answer')
}

function threadArg(value: unknown): string | null {
  return value === null ? null : str(value, 'threadId')
}

function exportLog(id: string, threadId: string | null): { title: string; markdown: string } {
  const s = store!
  const session = s.getSession(id)
  if (!session) throw new Error(`Unknown session ${id}`)
  const markdown = toMarkdown(
    { session, messages: s.listMessages(id), toolCalls: s.listToolCalls(id), threads: s.listThreads(id) },
    threadId
  )
  return { title: session.title, markdown }
}

async function pickFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

function registerIpc(manager: SessionManager, settingsFile: SettingsFile): void {
  ipcMain.handle(IPC.agentsList, async () => {
    const status = await openCode.check(settingsFile.state().global.opencodeExecutable)
    const builtins = listAgents().map((agent) => agent.id === 'opencode'
      ? { ...agent, available: status.available, setupMessage: status.error ?? undefined }
      : agent)
    const profiles = settingsFile.state().global.agentProfiles ?? []
    const missing = new Set(manager.listSessions().map((s) => s.agentId).filter((id) => id.startsWith('custom:') && !profiles.some((p) => p.id === id)))
    const defaultId = settingsFile.state().global.defaultAgent
    if (defaultId.startsWith('custom:') && !profiles.some((p) => p.id === defaultId)) missing.add(defaultId)
    return [...builtins, ...profiles.map((p) => ({ id: p.id, name: p.name })), ...[...missing].map((id) => ({ id, name: id, available: false, setupMessage: 'Restore this profile with the same ID in Settings > Agents to resume its conversations.' }))]
  })
  ipcMain.handle(IPC.agentsTestProfile, (_e, profile: unknown) => {
    const error = profileError(profile)
    if (error) throw new Error(error)
    return profileSupport.check(profile as AgentProfile)
  })
  ipcMain.handle(IPC.agentsTestOpenCode, (_e, executable: unknown) => openCode.check(str(executable, 'executable'), true))
  ipcMain.handle(IPC.projectsList, () => manager.listProjects())
  ipcMain.handle(IPC.projectsOpen, async () => {
    const path = await pickFolder()
    return path ? manager.addProject(path) : null
  })
  ipcMain.handle(IPC.projectsAgentSessions, (_e, path: unknown, agentId: unknown) =>
    manager.agentSessions(folderArg(path, 'path'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.projectsDelete, (_e, path: unknown) => manager.deleteProject(folderArg(path, 'path')))
  registerComposerIpc(store!, isGlossSender, () => settingsFile.state().global.externalEditor, (sender) => {
    const win = glossWindows().find((w) => w.webContents === sender)
    if (!win) return
    bringForward(win)
    void takeForeground(win.getNativeWindowHandle())
  })
  ipcMain.handle(IPC.sessionsList, () => manager.listSessions())
  ipcMain.handle(IPC.readMarkdownImage, (e, src: unknown, cwd: unknown) => {
    if (!isGlossSender(e.sender)) throw new Error('Only a Gloss window can load images.')
    return readMarkdownImage(str(src, 'src'), cwd === undefined ? undefined : folderArg(cwd, 'cwd'))
  })
  ipcMain.handle(IPC.openFileLink, async (_e, href: unknown) => {
    const link = fileLink(str(href, 'href'))
    if (!link || !isAbsolute(link.path)) throw new Error('Expected an absolute local file path.')
    if (!(await stat(link.path)).isFile()) throw new Error('This link does not point to a file.')
    const args = editorArgs(settingsFile.state().global.externalEditor, link.path, link.line)
    if (args.length > 0) return launchEditor(args, link.path)
    // Never execute a linked file through its default app association.
    shell.showItemInFolder(link.path)
  })
  ipcMain.handle(IPC.search, (_e, request: SearchRequest) => store!.search(request))
  ipcMain.handle(IPC.history, () => manager.messageHistory())
  registerCaptureIpc()
  ipcMain.handle(IPC.captureShortcutStatus, () => ({ shortcut: capture.registered, error: capture.error }))
  ipcMain.handle(IPC.capturePauseShortcut, (e, paused: unknown) => {
    if (e.sender !== mainWindow?.webContents) return
    capture.paused = paused === true
    setCaptureShortcut(capture.setting)
  })
  ipcMain.handle(IPC.captureStart, (e) => {
    const win = glossWindows().find((w) => w.webContents === e.sender)
    if (!win) throw new Error('Only a Gloss window can start a capture.')
    return startCapture({
      preload: join(__dirname, '../preload/capture.js'),
      load: (overlay) => loadPage(overlay, 'capture.html'),
      // Started from another app (the global shortcut), the canvas needs its window in front.
      // An overlay has the focus now, so Windows lets Gloss take it.
      onPicked: () => {
        if (!win.isDestroyed()) bringForward(win)
      }
    })
  })
  ipcMain.handle(IPC.sessionsCreate, (_e, cwd: unknown, agentId: unknown) =>
    manager.createSession(folderArg(cwd, 'cwd'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.sessionsCreateReview, (_e, cwd: unknown, agentId: unknown, baseRef: unknown, headRef: unknown) =>
    manager.createReview(
      folderArg(cwd, 'cwd'),
      str(agentId, 'agentId'),
      baseRef == null ? undefined : { baseRef: str(baseRef, 'baseRef'), ...(headRef == null ? {} : { headRef: str(headRef, 'headRef') }) }
    )
  )
  ipcMain.handle(IPC.sessionsRunReview, (_e, id: unknown) => manager.runReview(str(id, 'id')))
  ipcMain.handle(IPC.sessionsReviewRefs, (_e, id: unknown) => manager.reviewRefs(str(id, 'id')))
  ipcMain.handle(IPC.sessionsOpenReviewFile, async (_e, id: unknown, path: unknown, how: unknown, line: unknown) => {
    const file = await manager.reviewFilePath(str(id, 'id'), str(path, 'path'))
    if (how === 'reveal') return shell.showItemInFolder(file)
    const args = editorArgs(settingsFile.state().global.externalEditor, file, typeof line === 'number' && line > 0 ? Math.floor(line) : 1)
    if (args.length > 0) return launchEditor(args, file)
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.sessionsSetReviewRange, (_e, id: unknown, baseRef: unknown, headRef: unknown) =>
    manager.setReviewRange(str(id, 'id'), {
      baseRef: str(baseRef, 'baseRef'),
      ...(headRef == null ? {} : { headRef: str(headRef, 'headRef') })
    })
  )
  ipcMain.handle(IPC.sessionsReviewDiff, (_e, id: unknown) => manager.reviewDiff(str(id, 'id')))
  ipcMain.handle(IPC.sessionsReviewFile, (_e, id: unknown, path: unknown) =>
    manager.reviewFile(str(id, 'id'), str(path, 'path'))
  )
  ipcMain.handle(
    IPC.sessionsImport,
    (_e, cwd: unknown, agentId: unknown, acpSessionId: unknown, title: unknown, listedAt: unknown) =>
      manager.importSession(
        folderArg(cwd, 'cwd'),
        str(agentId, 'agentId'),
        str(acpSessionId, 'acpSessionId'),
        str(title, 'title'),
        typeof listedAt === 'string' ? listedAt : undefined
      )
  )
  ipcMain.handle(IPC.sessionsRewindPoints, (e, id: unknown) => {
    if (!isGlossSender(e.sender)) throw new Error('Only a Gloss window can rewind.')
    const sessionId = str(id, 'id')
    const session = store!.getSession(sessionId)
    if (!session) throw new Error('Session no longer exists.')
    const messages = store!.listMessages(sessionId)
    return messages.flatMap((m, index) => m.role === 'user' ? [{ id: m.id, text: m.text.slice(0, 500), threadId: m.threadId, createdAt: m.createdAt, laterMessages: messages.length - index - 1, sessionTitle: session.title, outcome: m.outcome }] : []).reverse()
  })
  ipcMain.handle(IPC.sessionsRewind, async (e, id: unknown, messageId: unknown) => {
    if (!isGlossSender(e.sender)) throw new Error('Only a Gloss window can rewind.')
    const sessionId = str(id, 'id')
    const targetId = str(messageId, 'messageId')
    const message = store!.listMessages(sessionId).find((m) => m.id === targetId && m.role === 'user')
    if (!message) throw new Error('That rewind point no longer exists.')
    await manager.rewindSession(sessionId, targetId)
    return { text: message.text, attachments: message.attachments ?? [] }
  })
  ipcMain.handle(IPC.sessionsOpen, (_e, id: unknown) => manager.openSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsRefresh, (_e, id: unknown) => manager.refreshSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsRename, (_e, id: unknown, title: unknown) =>
    manager.renameSession(str(id, 'id'), str(title, 'title'))
  )
  ipcMain.handle(IPC.sessionsDelete, (_e, id: unknown) => manager.deleteSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsSetChoice, (_e, id: unknown, kind: unknown, value: unknown) => {
    if (kind !== 'model' && kind !== 'effort') throw new Error('kind must be "model" or "effort"')
    return manager.setChoice(str(id, 'id'), kind, str(value, 'value'))
  })
  ipcMain.handle(IPC.sessionsSetMode, (_e, id: unknown, modeId: unknown) => manager.setMode(str(id, 'id'), str(modeId, 'modeId')))
  ipcMain.handle(IPC.sessionsSetAutoApprove, (_e, id: unknown, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('Expected on to be a boolean')
    return manager.setAutoApprove(str(id, 'id'), on)
  })
  ipcMain.handle(IPC.requestsAnswer, (_e, sessionId: unknown, requestId: unknown, answer: unknown) =>
    manager.answerRequest(str(sessionId, 'sessionId'), str(requestId, 'requestId'), answerArg(answer))
  )
  ipcMain.handle(IPC.sessionsCopyMarkdown, (_e, id: unknown, threadId: unknown) => {
    clipboard.writeText(exportLog(str(id, 'id'), threadArg(threadId)).markdown)
  })
  ipcMain.handle(IPC.sessionsSaveMarkdown, async (e, id: unknown, threadId: unknown) => {
    const { title, markdown } = exportLog(str(id, 'id'), threadArg(threadId))
    const options: Electron.SaveDialogOptions = {
      defaultPath: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'session'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    // Over the window that asked.
    const parent = glossWindows().find((w) => w.webContents === e.sender)
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, markdown)
    return true
  })
  // Takes the session, not a path: shell.openPath would run a file it was given.
  ipcMain.handle(IPC.sessionsOpenFolder, async (_e, id: unknown) => {
    const session = store!.getSession(str(id, 'id'))
    if (!session) throw new Error(`Unknown session ${String(id)}`)
    const error = await shell.openPath(session.cwd)
    return error === '' ? null : error
  })
  ipcMain.handle(IPC.sessionsOpenObsidian, async (_e, id: unknown) => {
    const session = store!.getSession(str(id, 'id'))
    if (!session) throw new Error(`Unknown session ${String(id)}`)
    const vault = projectSettings(settingsFile.state().projects, session.cwd).obsidianVault
    if (!vault?.trim()) throw new Error('Set an Obsidian vault in project settings first.')
    await shell.openExternal(obsidianUri(vault))
  })
  ipcMain.handle(IPC.sessionsPlanUsage, (_e, id: unknown) => {
    const session = store!.getSession(str(id, 'id'))
    if (!session) throw new Error(`Unknown session ${String(id)}`)
    return usage.get(session.agentId, session.cwd)
  })
  ipcMain.handle(IPC.gitStatus, (_e, cwd: unknown) => gitStatus(str(cwd, 'cwd')))
  ipcMain.handle(IPC.gitPullRequest, (_e, cwd: unknown) => pullRequest(str(cwd, 'cwd')))
  ipcMain.handle(IPC.threadsCreate, (_e, sessionId: unknown, anchorMessageId: unknown, anchor: unknown) =>
    manager.createThread(
      str(sessionId, 'sessionId'),
      anchorMessageId === null ? null : str(anchorMessageId, 'anchorMessageId'),
      anchorArg(anchor)
    )
  )
  ipcMain.handle(IPC.threadsResolve, (_e, sessionId: unknown, threadId: unknown, resolved: unknown) => {
    if (typeof resolved !== 'boolean') throw new Error('Expected resolved to be a boolean')
    return manager.resolveThread(str(sessionId, 'sessionId'), str(threadId, 'threadId'), resolved)
  })
  ipcMain.handle(
    IPC.send,
    (_e, sessionId: unknown, text: unknown, threadId: unknown, attachments: unknown, fromThread: unknown) =>
      manager.send(
        str(sessionId, 'sessionId'),
        str(text, 'text'),
        threadArg(threadId),
        attachmentsArg(attachments),
        threadArg(fromThread)
      )
  )
  ipcMain.handle(IPC.steer, (_e, sessionId: unknown, text: unknown, threadId: unknown, attachments: unknown) =>
    manager.steer(str(sessionId, 'sessionId'), str(text, 'text'), threadArg(threadId), attachmentsArg(attachments))
  )
  // The main window's renderer owns the badge (SPEC → Session windows).
  ipcMain.on(IPC.setBadge, (e, badge: unknown) => {
    if (e.sender === mainWindow?.webContents) setBadge(badge)
  })
  registerWindowsIpc()
  ipcMain.handle(IPC.retry, (_e, sessionId: unknown, messageId: unknown) => manager.retry(str(sessionId, 'sessionId'), str(messageId, 'messageId')))
  ipcMain.handle(IPC.cancel, (_e, sessionId: unknown) => manager.cancel(str(sessionId, 'sessionId')))
  ipcMain.handle(IPC.queueEdit, (_e, sessionId: unknown, id: unknown, text: unknown) =>
    manager.editQueued(str(sessionId, 'sessionId'), str(id, 'id'), str(text, 'text'))
  )
  ipcMain.handle(IPC.queueRemove, (_e, sessionId: unknown, id: unknown) =>
    manager.removeQueued(str(sessionId, 'sessionId'), str(id, 'id'))
  )
  ipcMain.handle(IPC.queueResume, (_e, sessionId: unknown) => manager.resumeQueue(str(sessionId, 'sessionId')))
  ipcMain.handle(IPC.authSignIn, (_e, agentId: unknown, methodId: unknown) =>
    manager.signIn(str(agentId, 'agentId'), str(methodId, 'methodId'))
  )
  ipcMain.handle(IPC.authDismiss, (_e, agentId: unknown) =>
    manager.dismissSignIn(str(agentId, 'agentId'))
  )

  ipcMain.handle(IPC.settingsGet, () => settingsFile.state())
  ipcMain.handle(IPC.settingsPreviewMcpImport, (_e, source: unknown) => {
    if (source !== 'claude' && source !== 'codex' && source !== 'gloss') throw new Error('Unknown MCP import source')
    return previewMcpImport(source, { projects: manager.listProjects().map((p) => p.path), legacy: settingsFile.state().projects })
  })
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: unknown) => settingsFile.update(patchArg(patch)))
  ipcMain.handle(IPC.settingsOpenFile, async () => {
    const error = await shell.openPath(settingsFile.path)
    return error === '' ? null : error
  })
}

/** What a session's view showed, sent along when it moves to another window. */
function paneStateArg(value: unknown, sessionId: string): PaneState {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<string, unknown>>
  const drafts: PaneState['drafts'] = {}
  if (typeof v.drafts === 'object' && v.drafts !== null) {
    for (const [key, draft] of Object.entries(v.drafts as Record<string, unknown>)) {
      // A session's drafts only: their keys start with its id.
      if (!key.startsWith(sessionId)) continue
      const d = draft as Partial<Record<string, unknown>> | null
      if (!d || typeof d.text !== 'string' || d.text.length > MAX_FILE_CHARS) continue
      drafts[key] = { text: d.text, attachments: attachmentsArg(d.attachments ?? []) }
    }
  }
  const scroll: PaneState['scroll'] = {}
  if (typeof v.scroll === 'object' && v.scroll !== null) {
    for (const [key, spot] of Object.entries(v.scroll as Record<string, unknown>)) {
      const p = spot as Partial<Record<string, unknown>> | null
      if (!key.startsWith(sessionId) || !p) continue
      if (p.bottom === true) scroll[key] = { bottom: true }
      else if (typeof p.id === 'string' && typeof p.offset === 'number' && Number.isFinite(p.offset)) {
        scroll[key] = { id: p.id, ...(typeof p.block === 'string' ? { block: p.block } : {}), offset: p.offset }
      }
    }
  }
  return {
    threadId: typeof v.threadId === 'string' ? v.threadId : null,
    sideOpen: v.sideOpen === true,
    general: v.general === true,
    sideTab: v.sideTab === 'queue' ? 'queue' : 'threads',
    expandedFiles: Array.isArray(v.expandedFiles) ? v.expandedFiles.filter((f): f is string => typeof f === 'string') : [],
    drafts,
    scroll
  }
}

function mainActionArg(value: unknown): MainAction {
  const a = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<string, unknown>>
  if (a.kind === 'search' || a.kind === 'newSession' || a.kind === 'settings') return { kind: a.kind }
  if (a.kind === 'cycleSession') return { kind: 'cycleSession', back: a.back === true }
  if (a.kind === 'newReview') return { kind: 'newReview', sessionId: str(a.sessionId, 'sessionId') }
  throw new Error('Unknown action')
}

/** Session windows (SPEC → Session windows). */
function registerWindowsIpc(): void {
  ipcMain.handle(IPC.windowsPopOut, (e, id: unknown, state: unknown) => {
    if (e.sender !== mainWindow?.webContents) throw new Error('Only the main window can pop out a session.')
    const sessionId = str(id, 'sessionId')
    if (!store?.getSession(sessionId)) throw new Error('Session no longer exists.')
    const open = sessionWindows.get(sessionId)
    if (open && !open.isDestroyed()) return bringForward(open)
    openSessionWindow(sessionId, paneStateArg(state, sessionId))
  })
  ipcMain.handle(IPC.windowsPopIn, (e, state: unknown) => {
    const sessionId = windowSession(e.sender)
    const win = sessionId ? sessionWindows.get(sessionId) : undefined
    const main = mainWindow
    if (!sessionId || !win || !main || main.isDestroyed()) throw new Error('Only a session window can return to the main window.')
    const pane = paneStateArg(state, sessionId)
    // Listed as back in the main window before it opens the session there.
    sessionWindows.delete(sessionId)
    sendWindows()
    main.webContents.send(IPC.event, { type: 'popIn', sessionId, state: pane } satisfies GlossEvent)
    win.close()
    bringForward(main)
  })
  ipcMain.handle(IPC.windowsFocus, (_e, id: unknown) => {
    const win = sessionWindows.get(str(id, 'sessionId'))
    if (!win || win.isDestroyed()) return false
    bringForward(win)
    return true
  })
  ipcMain.handle(IPC.windowsList, () => ({
    popped: [...sessionWindows.keys()],
    focused: [...sessionWindows].find(([, w]) => !w.isDestroyed() && w.isFocused())?.[0] ?? null
  }))
  ipcMain.handle(IPC.windowsInitial, (e) => windowStates.get(e.sender.id) ?? null)
  ipcMain.on(IPC.windowsToMain, (e, action: unknown) => {
    const main = mainWindow
    if (!windowSession(e.sender) || !main || main.isDestroyed()) return
    let parsed: MainAction
    try {
      parsed = mainActionArg(action)
    } catch {
      return
    }
    bringForward(main)
    main.webContents.send(IPC.event, { type: 'mainAction', action: parsed } satisfies GlossEvent)
  })
}

// Windows shows notifications only for an app with an AppUserModelID.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'app.gloss' : process.execPath)

app.whenReady().then(() => {
  // No File/Edit/View/Window menu bar on Windows and Linux. macOS keeps its menu
  // (it lives in the system menu bar, and copy and paste need its Edit menu).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const dataDir = app.getPath('userData')
  openCode = new OpenCodeSupport(dataDir)
  profileSupport = new AgentProfileSupport(dataDir)
  store = new Store(join(dataDir, 'gloss.db'))
  const settingsFile = new SettingsFile({
    dir: dataDir,
    defaults: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false, turnEndSound: true, permissionMode: 'bypass', externalEditor: DEFAULT_EXTERNAL_EDITOR, mcpServers: [], captureShortcut: DEFAULT_CAPTURE_SHORTCUT },
    onChange(next, previous) {
      emit({ type: 'settings', state: next })
      // Fires nativeTheme's 'updated', which recolors the window controls.
      if (next.global.theme !== previous.global.theme) nativeTheme.themeSource = next.global.theme
      if (next.global.captureShortcut !== previous.global.captureShortcut) setCaptureShortcut(next.global.captureShortcut)
      if (next.global.opencodeExecutable !== previous.global.opencodeExecutable) {
        openCodeRestartPending = true
        void sessions?.restartIdleAgent('opencode').then((restarted) => { if (restarted) openCodeRestartPending = false })
      }
      for (const p of [...(next.global.agentProfiles ?? []), ...(previous.global.agentProfiles ?? [])]) {
        const nextProfile = next.global.agentProfiles?.find((entry) => entry.id === p.id)
        if (JSON.stringify(nextProfile) !== JSON.stringify(appliedProfiles.get(p.id))) pendingProfiles.add(p.id)
      }
      void applyProfileChanges()
    }
  })
  settings = settingsFile
  settingsFile.load()
  for (const profile of settingsFile.state().global.agentProfiles ?? []) appliedProfiles.set(profile.id, profile)
  pendingProfiles.clear()
  nativeTheme.themeSource = settingsFile.state().global.theme
  setCaptureShortcut(settingsFile.state().global.captureShortcut)
  settingsFile.watch()
  sessions = new SessionManager({
    store,
    emit,
    getAgentConfig: (id) => id === 'opencode'
      ? openCode.config(settingsFile.state().global.opencodeExecutable)
      : id.startsWith('custom:') ? (() => {
        const profile = appliedProfiles.get(id)
        if (!profile) throw new Error('This agent profile was removed. Restore it with the same ID in Settings > Agents to resume this conversation.')
        return profileSupport.config(profile)
      })() : getAgentConfig(id),
    mcpServers: () => settingsFile.state().global.mcpServers,
    permissionMode: (cwd) => {
      const state = settingsFile.state()
      const project = projectSettings(state.projects, cwd).permissionMode
      return project && project !== 'inherit' ? project : state.global.permissionMode
    },
    agentEnv: (config) => agentEnv(config),
    connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
    runInTerminal
  })
  registerIpc(sessions, settingsFile)
  nativeTheme.on('updated', updateTitleBar)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  settings?.close()
  void sessions?.dispose()
  store?.close()
})
