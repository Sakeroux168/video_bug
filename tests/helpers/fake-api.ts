import { vi } from 'vitest'
import type { Api } from '../../src/preload'
import type { AppSettings } from '../../src/shared/types'

/**
 * 渲染层组件测试的假 api（替代 preload 注入的 window.api，不让真实 IPC 泄漏进 jsdom）。
 * 所有方法都是 vi.fn()，默认返回空 Promise/空数组；测试可按需覆写：
 *   installFakeApi() 之后取窗口上的对象：window.api.listTasks.mockResolvedValue([...])
 *
 * 注意：api.ts 在模块加载时已捕获 window.api 的对象引用，因此重新安装必须在原对象上
 * 原地替换方法（installFakeApi 每次都刷新同一对象的方法），不能整体换对象。
 */

function freshApi(): Api {
  return {
    ping: vi.fn(() => 'pong'),
    listPlatforms: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: null, skipped: false })),
    listTasks: vi.fn(async () => []),
    listTaskVideos: vi.fn(async () => []),
    getTaskStats: vi.fn(async () => ({
      total: 0, done: 0, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0
    })),
    pauseTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => {}),
    retryVideos: vi.fn(async () => true),
    deleteVideos: vi.fn(async () => ({ ok: true, deleted: 0 })),
    downloadPause: vi.fn(async () => true),
    downloadResume: vi.fn(async () => true),
    getDownloadState: vi.fn(async () => ({ paused: false })),
    downloadVideos: vi.fn(async () => true),
    cancelVideos: vi.fn(async () => true),
    pauseVideos: vi.fn(async () => true),
    resumeVideos: vi.fn(async () => true),
    listAuthors: vi.fn(async () => []),
    updateAuthorCategory: vi.fn(async () => true),
    deleteAuthors: vi.fn(async () => true),
    getGlobalStats: vi.fn(async () => ({
      videos: { total: 0, pending: 0, downloading: 0, done: 0, failed: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 },
      tasks: { total: 0, pending: 0, running: 0, done: 0, paused: 0, failed: 0 }
    })),
    listDownloadedVideos: vi.fn(async () => []),
    getRecentDownloads: vi.fn(async () => []),
    writeClipboard: vi.fn(async () => {}),
    openVideoSource: vi.fn(async () => ({ ok: true })),
    importAuthors: vi.fn(async () => ({ created: 0, results: [] })),
    organizeAuthor: vi.fn(async () => ({ ok: true })),
    organizeAll: vi.fn(async () => ({ ok: true })),
    getAsrStatus: vi.fn(async () => ({ dir: '', ready: false, files: [], totalBytes: 0 })),
    downloadAsrModels: vi.fn(async () => ({ ok: true })),
    onAsrProgress: vi.fn(() => () => {}),
    getSettings: vi.fn(async () => makeSettings()),
    saveSettings: vi.fn(async () => {}),
    testAi: vi.fn(async () => ({ ok: true })),
    openBrowserFor: vi.fn(async () => ({ ok: true })),
    showBrowser: vi.fn(async () => {}),
    hideBrowser: vi.fn(async () => {}),
    pickDownloadDir: vi.fn(async () => null),
    openDir: vi.fn(async () => {}),
    locateVideo: vi.fn(async () => {}),
    openBrowserDevtools: vi.fn(async () => {}),
    getRawLog: vi.fn(async () => []),
    getFilesTree: vi.fn(async () => ({ categories: [], totalSize: 0, downloadDir: '' })),
    deleteFileCategory: vi.fn(async () => ({ ok: true, deleted: 0, filesRemoved: true })),
    deleteFileAuthor: vi.fn(async () => ({ ok: true, deleted: 0, filesRemoved: true })),
    locateFileDir: vi.fn(async () => ({ ok: true })),
    onTaskProgress: vi.fn(() => () => {}),
    onTaskNotice: vi.fn(() => () => {})
  }
}

function makeSettings(): AppSettings {
  return {
    downloadDir: '', aiBaseUrl: '', aiApiKey: '', aiModel: '', downloadConcurrency: 3,
    normalizeVideo: true, keepOriginalVideo: false,
    scrollIntervalMs: 3000, scrollSpeed: 'medium', scrollPageWaitMs: 8000,
    addressTtlMin: 10, allowDuplicateAuthor: false, organizeDebounceMs: 5000, asrMaxSec: 90,
    stallThresholdSec: 5, rescueCooldownSec: 10,
    organizeByCategory: false, organizeByAuthor: false, organizeByOrientation: false, organizeByDuration: false
  }
}

let installed: Api | null = null

/**
 * 安装假 api 到 window.api。首次调用创建对象并挂到 window；之后调用把新假 api 的
 * 方法原地替换到已安装对象上（恢复默认实现），保证 api.ts 捕获的引用始终有效。
 * 仅在 jsdom 环境（window 存在）下工作。
 */
export function installFakeApi(): Api | null {
  if (typeof window === 'undefined') return null
  const fresh = freshApi()
  if (!installed) {
    installed = fresh
    ;(window as unknown as { api: Api }).api = installed
  } else {
    for (const key of Object.keys(fresh) as (keyof Api)[]) {
      ;(installed as unknown as Record<string, unknown>)[key] = fresh[key]
    }
  }
  return installed
}

/** 当前已安装的假 api（未安装返回 null） */
export function getFakeApi(): Api | null {
  return installed
}
