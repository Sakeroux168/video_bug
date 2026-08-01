import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, AppSettings, TaskRow, VideoRow, AuthorRow } from '../shared/types'

const api = {
  ping: () => ipcRenderer.sendSync('api:ping') as string,
  listPlatforms: (): Promise<Array<{ name: string; displayName: string }>> => ipcRenderer.invoke('platforms:list'),
  createTask: (input: CreateTaskInput): Promise<{ id: number | null; skipped: boolean; reason?: string }> => ipcRenderer.invoke('task:create', input),
  listTasks: (): Promise<TaskRow[]> => ipcRenderer.invoke('task:list'),
  listTaskVideos: (taskId: number): Promise<VideoRow[]> => ipcRenderer.invoke('task:video:list', taskId),
  pauseTask: (id: number): Promise<void> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: number): Promise<void> => ipcRenderer.invoke('task:resume', id),
  deleteTask: (id: number): Promise<void> => ipcRenderer.invoke('task:delete', id),
  retryVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:retry', ids),
  listAuthors: (): Promise<AuthorRow[]> => ipcRenderer.invoke('authors:list'),
  updateAuthorCategory: (id: number, category: string): Promise<boolean> => ipcRenderer.invoke('authors:updateCategory', id, category),
  deleteAuthors: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('authors:delete', ids),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  testAi: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:test'),
  showBrowser: (): Promise<void> => ipcRenderer.invoke('browser:show'),
  hideBrowser: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  openDir: (p: string): Promise<void> => ipcRenderer.invoke('dialog:openDir', p),
  locateVideo: (p: string): Promise<void> => ipcRenderer.invoke('video:locate', p),
  openBrowserDevtools: (): Promise<void> => ipcRenderer.invoke('browser:devtools'),
  onTaskProgress: (cb: (e: unknown) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('evt:task:progress', l)
    return () => ipcRenderer.removeListener('evt:task:progress', l)
  },
  onTaskNotice: (cb: (e: unknown) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('evt:task:notice', l)
    return () => ipcRenderer.removeListener('evt:task:notice', l)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
