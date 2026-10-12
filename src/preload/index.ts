import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type GlossApi, type GlossEvent } from '../shared/ipc'

const api: GlossApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    setDevModel: (on) => ipcRenderer.invoke(IPC.settingsSetDevModel, on === true)
  },
  spike: {
    run: () => ipcRenderer.invoke(IPC.spikeRun)
  },
  onEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: GlossEvent): void => listener(event)
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.removeListener(IPC.event, wrapped)
  }
}

contextBridge.exposeInMainWorld('gloss', api)
