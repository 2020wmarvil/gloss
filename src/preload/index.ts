import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { makeApi } from '../shared/api'
import { IPC, type GlossEvent } from '../shared/ipc'

contextBridge.exposeInMainWorld('gloss', makeApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) as Promise<never>,
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  onEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: GlossEvent): void => listener(event)
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.removeListener(IPC.event, wrapped)
  },
  pathFor: (file) => webUtils.getPathForFile(file)
}))
