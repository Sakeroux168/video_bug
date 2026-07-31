import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  ping: (): string => ipcRenderer.sendSync('api:ping') as string
})
