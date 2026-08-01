import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, AppSettings } from '../shared/types'

const api = {
  ping: () => ipcRenderer.sendSync('api:ping') as string,
  listPlatforms: (): Promise<Array<{ name: string; displayName: string }>> => ipcRenderer.invoke('platforms:list'),
  createTask: (input: CreateTaskInput): Promise<number> => ipcRenderer.invoke('task:create', input),
  listTasks: (): Promise<unknown[]> => ipcRenderer.invoke('task:list'),
  listTaskVideos: (taskId: number): Promise<unknown[]> => ipcRenderer.invoke('task:video:list', taskId),
  pauseTask: (id: number): Promise<void> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: number): Promise<void> => ipcRenderer.invoke('task:resume', id),
  deleteTask: (id: number): Promise<void> => ipcRenderer.invoke('task:delete', id),
  retryVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:retry', ids),
  listAuthors: (): Promise<unknown[]> => ipcRenderer.invoke('authors:list'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  testAi: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:test'),
  showBrowser: (): Promise<void> => ipcRenderer.invoke('browser:show'),
  hideBrowser: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
  onTaskProgress: (cb: (e: unknown) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('evt:task:progress', l)
    return () => ipcRenderer.removeListener('evt:task:progress', l)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
