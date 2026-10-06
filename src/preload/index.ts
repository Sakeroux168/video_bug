import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, AppSettings, TaskRow, VideoRow, AuthorRow, TaskStats, AsrStatus, AsrProgress, FilesTree, FileDeleteResult, TaskProgressEvent, GlobalStats, RecentDownload, ProcessState } from '../shared/types'

const api = {
  exportCsv: (input: { csv: string; fileName: string }): Promise<import('../shared/types').CsvExportResult> => ipcRenderer.invoke('csv:export', input),
  revealExport: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('csv:reveal', path),
  getLoginStatuses: (): Promise<import('../shared/types').PlatformLoginStatus[]> => ipcRenderer.invoke('platforms:login-status'),
  ping: () => ipcRenderer.sendSync('api:ping') as string,
  listPlatforms: (): Promise<Array<{ name: string; displayName: string; authorInputPlaceholder: string; taskReady: boolean; supportedTaskTypes?: readonly ('keyword' | 'author' | 'hashtag')[] }>> => ipcRenderer.invoke('platforms:list'),
  createTask: (input: CreateTaskInput): Promise<{ id: number | null; skipped: boolean; reason?: string }> => ipcRenderer.invoke('task:create', input),
  listTasks: (): Promise<TaskRow[]> => ipcRenderer.invoke('task:list'),
  listTaskVideos: (taskId: number): Promise<VideoRow[]> => ipcRenderer.invoke('task:video:list', taskId),
  getTaskStats: (taskId: number): Promise<TaskStats> => ipcRenderer.invoke('task:stats', taskId),
  getTaskStatsMany: (ids: number[]): Promise<Record<number, TaskStats>> => ipcRenderer.invoke('task:statsMany', ids),
  pauseTask: (id: number): Promise<void> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: number): Promise<void> => ipcRenderer.invoke('task:resume', id),
  deleteTask: (id: number): Promise<void> => ipcRenderer.invoke('task:delete', id),
  retryVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:retry', ids),
  deleteVideos: (ids: number[]): Promise<{ ok: boolean; deleted: number; error?: string }> => ipcRenderer.invoke('video:delete', ids),
  listDeletedTaskVideos: (taskId: number): Promise<VideoRow[]> => ipcRenderer.invoke('task:video:listDeleted', taskId),
  restoreVideos: (ids: number[]): Promise<{ restored: number }> => ipcRenderer.invoke('video:restore', ids),
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
  listDownloadedVideos: (): Promise<VideoRow[]> => ipcRenderer.invoke('videos:downloaded'),
  getRecentDownloads: (limit?: number): Promise<RecentDownload[]> => ipcRenderer.invoke('stats:recent', limit),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openVideoSource: (id: number): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('video:source:open', id),
  importAuthors: (items: Array<{ nickname: string; url: string }>, platform: string): Promise<{ created: number; results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> }> => ipcRenderer.invoke('authors:import', items, platform),
  organizeAuthor: (id: number): Promise<{ ok: boolean; moved?: number; category?: string; state?: string; skipped?: boolean; error?: string }> => ipcRenderer.invoke('authors:organize', id),
  organizeAll: (): Promise<{ ok: boolean; count?: number; skipped?: boolean; error?: string }> => ipcRenderer.invoke('organize:all'),
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
  openBrowserFor: (platform: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('browser:open', platform),
  showBrowser: (): Promise<void> => ipcRenderer.invoke('browser:show'),
  hideBrowser: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  /** 视频处理页：选待处理文件夹（同一个目录选择框，只是标题不同） */
  pickVideoDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', '选择要处理的视频文件夹'),
  // 视频处理（统一分辨率批处理）：状态住在主进程，这里只发指令 + 订阅快照
  getProcessState: (): Promise<ProcessState> => ipcRenderer.invoke('process:state'),
  processStart: (dir: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('process:start', dir),
  processPause: (): Promise<void> => ipcRenderer.invoke('process:pause'),
  processResume: (): Promise<void> => ipcRenderer.invoke('process:resume'),
  processStop: (): Promise<void> => ipcRenderer.invoke('process:stop'),
  onProcessState: (cb: (s: ProcessState) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data as ProcessState)
    ipcRenderer.on('evt:process:state', l)
    return () => ipcRenderer.removeListener('evt:process:state', l)
  },
  openDir: (p: string): Promise<void> => ipcRenderer.invoke('dialog:openDir', p),
  locateVideo: (p: string): Promise<void> => ipcRenderer.invoke('video:locate', p),
  openBrowserDevtools: (): Promise<void> => ipcRenderer.invoke('browser:devtools'),
  getRawLog: (): Promise<Array<{ at: string; url?: string; handled?: boolean; stats?: { items: number; kept: number }; durationZero?: boolean; topKeys?: string[]; filterLog?: string }>> => ipcRenderer.invoke('debug:rawLog'),
  getFilesTree: (): Promise<FilesTree> => ipcRenderer.invoke('files:tree'),
  /** 文件管理删除/定位都以「相对下载目录的段落」寻址：任意层级通用，主进程逐段校验 + 路径防护 */
  deleteFileDir: (segments: string[]): Promise<FileDeleteResult> => ipcRenderer.invoke('files:deleteDir', segments),
  deleteFileVideo: (segments: string[]): Promise<FileDeleteResult> => ipcRenderer.invoke('files:deleteFile', segments),
  locateFileDir: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('files:locate', path),
  locateVideoFile: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('files:locateFile', path),
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
