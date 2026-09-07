import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, AppSettings, TaskRow, VideoRow, AuthorRow, TaskStats, AsrStatus, AsrProgress, FilesTree, FileDeleteResult, TaskProgressEvent, GlobalStats, RecentDownload } from '../shared/types'

const api = {
  ping: () => ipcRenderer.sendSync('api:ping') as string,
  listPlatforms: (): Promise<Array<{ name: string; displayName: string; authorInputPlaceholder: string }>> => ipcRenderer.invoke('platforms:list'),
  createTask: (input: CreateTaskInput): Promise<{ id: number | null; skipped: boolean; reason?: string }> => ipcRenderer.invoke('task:create', input),
  listTasks: (): Promise<TaskRow[]> => ipcRenderer.invoke('task:list'),
  listTaskVideos: (taskId: number): Promise<VideoRow[]> => ipcRenderer.invoke('task:video:list', taskId),
  getTaskStats: (taskId: number): Promise<TaskStats> => ipcRenderer.invoke('task:stats', taskId),
  pauseTask: (id: number): Promise<void> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: number): Promise<void> => ipcRenderer.invoke('task:resume', id),
  deleteTask: (id: number): Promise<void> => ipcRenderer.invoke('task:delete', id),
  retryVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:retry', ids),
  deleteVideos: (ids: number[]): Promise<{ ok: boolean; deleted: number; error?: string }> => ipcRenderer.invoke('video:delete', ids),
  downloadPause: (): Promise<boolean> => ipcRenderer.invoke('download:pause'),
  downloadResume: (): Promise<boolean> => ipcRenderer.invoke('download:resume'),
  getDownloadState: (): Promise<{ paused: boolean }> => ipcRenderer.invoke('download:state'),
  downloadVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:download', ids),
  cancelVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:cancel', ids),
  pauseVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:pause', ids),
  resumeVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:resume', ids),
  listAuthors: (): Promise<AuthorRow[]> => ipcRenderer.invoke('authors:list'),
  updateAuthorCategory: (id: number, category: string): Promise<boolean> => ipcRenderer.invoke('authors:updateCategory', id, category),
  deleteAuthors: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('authors:delete', ids),
  getGlobalStats: (): Promise<GlobalStats> => ipcRenderer.invoke('stats:global'),
  getRecentDownloads: (limit?: number): Promise<RecentDownload[]> => ipcRenderer.invoke('stats:recent', limit),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openVideoSource: (id: number): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('video:source:open', id),
  importAuthors: (items: Array<{ nickname: string; url: string }>, platform: string): Promise<{ created: number; results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> }> => ipcRenderer.invoke('authors:import', items, platform),
  organizeAuthor: (id: number): Promise<{ ok: boolean; moved?: number; category?: string; state?: string; error?: string }> => ipcRenderer.invoke('authors:organize', id),
  organizeAll: (): Promise<{ ok: boolean; count?: number; error?: string }> => ipcRenderer.invoke('organize:all'),
  getAsrStatus: (): Promise<AsrStatus> => ipcRenderer.invoke('asr:status'),
  downloadAsrModels: (): Promise<{ ok: boolean; ready?: boolean; downloaded?: string[]; error?: string }> => ipcRenderer.invoke('asr:download'),
  onAsrProgress: (cb: (p: AsrProgress) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data as AsrProgress)
    ipcRenderer.on('evt:asr:progress', l)
    return () => ipcRenderer.removeListener('evt:asr:progress', l)
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  testAi: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:test'),
  showBrowser: (): Promise<void> => ipcRenderer.invoke('browser:show'),
  hideBrowser: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  openDir: (p: string): Promise<void> => ipcRenderer.invoke('dialog:openDir', p),
  locateVideo: (p: string): Promise<void> => ipcRenderer.invoke('video:locate', p),
  openBrowserDevtools: (): Promise<void> => ipcRenderer.invoke('browser:devtools'),
  getRawLog: (): Promise<Array<{ at: string; url?: string; handled?: boolean; stats?: { items: number; kept: number }; durationZero?: boolean; topKeys?: string[]; filterLog?: string }>> => ipcRenderer.invoke('debug:rawLog'),
  getFilesTree: (): Promise<FilesTree> => ipcRenderer.invoke('files:tree'),
  deleteFileCategory: (name: string): Promise<FileDeleteResult> => ipcRenderer.invoke('files:deleteCategory', name),
  deleteFileAuthor: (category: string, author: string): Promise<FileDeleteResult> => ipcRenderer.invoke('files:deleteAuthor', category, author),
  locateFileDir: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('files:locate', path),
  onTaskProgress: (cb: (e: TaskProgressEvent) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data as TaskProgressEvent)
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
