// The region overlay's preload (SPEC → Visual feedback): it may only read the frozen frame and
// say what was picked.
import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_IPC, type CaptureOverlayApi } from '../shared/capture'

const api: CaptureOverlayApi = {
  frame: () => ipcRenderer.invoke(CAPTURE_IPC.frame),
  done: (choice) => ipcRenderer.invoke(CAPTURE_IPC.done, choice)
}

contextBridge.exposeInMainWorld('glossCapture', api)
