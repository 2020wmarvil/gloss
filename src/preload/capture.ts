// The region overlay's preload (SPEC → Visual feedback): it may only read the frozen frame, say
// what was picked, and take the keys when the cursor comes onto its display.
import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_IPC, type CaptureOverlayApi } from '../shared/capture'

const api: CaptureOverlayApi = {
  frame: () => ipcRenderer.invoke(CAPTURE_IPC.frame),
  done: (choice) => ipcRenderer.invoke(CAPTURE_IPC.done, choice),
  enter: () => ipcRenderer.send(CAPTURE_IPC.enter)
}

contextBridge.exposeInMainWorld('glossCapture', api)
