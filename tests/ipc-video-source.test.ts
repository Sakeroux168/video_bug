import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createTask, initDb, insertVideos, listVideos } from '../src/main/db'
import type { VideoItem } from '../src/main/adapters/types'

const mockElectron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    openExternal: vi.fn(async (_url: string) => {}),
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown): void => { handlers.set(channel, fn) },
      on: () => {},
      removeHandler: () => {}
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: mockElectron.ipcMain,
  app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-ipc-video-source', getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: {
    openExternal: mockElectron.openExternal,
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn()
  },
  clipboard: { writeText: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

type OpenResult = { ok: boolean; url?: string; error?: string }

const item: VideoItem = {
  awemeId: 'AW1',
  title: '测试作品',
  authorSecUid: 'SEC1',
  authorNickname: '作者',
  authorHomeUrl: 'https://www.douyin.com/user/SEC1',
  playUrl: 'https://cdn.test/AW1.mp4',
  coverUrl: '',
  width: 1080,
  height: 1920,
  durationSec: 10,
  publishTime: 1710000000,
  likes: 1,
  comments: 2,
  sourceUrl: 'https://www.douyin.com/video/AW1'
}

function setup(): {
  db: DatabaseSync
  videoId: number
  openVideoSource: (id: number) => Promise<OpenResult>
  listTaskVideos: () => Promise<Array<{ source_url: string | null }>>
} {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  const taskId = createTask(db, {
    platform: 'douyin', type: 'keyword', query: '测试',
    filters: { timeRange: 'all', duration: 'all', targetCount: 1 },
    aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: false
  })
  insertVideos(db, [item], taskId, 'douyin')
  const videoId = listVideos(db, taskId)[0].id
  mockElectron.handlers.clear()
  registerIpc({
    db,
    scheduler: {} as never,
    downloader: {} as never,
    analyzer: null,
    browser: {} as never,
    getWindow: () => ({}) as never,
    reloadAnalyzer: () => {},
    reloadOrganizer: () => {},
    getOrganizer: () => null,
    enqueueTask: () => {},
    setBrowserVisible: () => {},
    processor: {} as never, dequeueTask: () => {}, kickQueue: () => {}
  })
  const openHandler = mockElectron.handlers.get('video:source:open')!
  const listHandler = mockElectron.handlers.get('task:video:list')!
  return {
    db,
    videoId,
    openVideoSource: (id) => Promise.resolve(openHandler(null, id) as OpenResult),
    listTaskVideos: () => Promise.resolve(listHandler(null, taskId) as Array<{ source_url: string | null }>)
  }
}

describe('video:source:open', () => {
  beforeEach(() => {
    mockElectron.openExternal.mockReset()
    mockElectron.openExternal.mockResolvedValue(undefined)
  })

  it('旧行链接为空时使用规范作品页，并让任务列表拿到同一链接', async () => {
    const { db, videoId, openVideoSource, listTaskVideos } = setup()
    db.prepare('UPDATE videos SET source_url=NULL WHERE id=?').run(videoId)

    await expect(listTaskVideos()).resolves.toEqual([
      expect.objectContaining({ source_url: 'https://www.douyin.com/video/AW1' })
    ])
    await expect(openVideoSource(videoId)).resolves.toEqual({
      ok: true,
      url: 'https://www.douyin.com/video/AW1'
    })
    expect(mockElectron.openExternal).toHaveBeenCalledWith('https://www.douyin.com/video/AW1')
  })

  it('数据库被污染为外部域名时拒绝打开且列表不回传污染值', async () => {
    const { db, videoId, openVideoSource, listTaskVideos } = setup()
    db.prepare('UPDATE videos SET source_url=? WHERE id=?').run('https://evil.example/video/AW1', videoId)

    await expect(listTaskVideos()).resolves.toEqual([
      expect.objectContaining({ source_url: null })
    ])
    await expect(openVideoSource(videoId)).resolves.toEqual({
      ok: false,
      error: '作品链接不安全或不受支持'
    })
    expect(mockElectron.openExternal).not.toHaveBeenCalled()
  })

  it('视频记录不存在时返回明确错误', async () => {
    const { openVideoSource } = setup()
    await expect(openVideoSource(99999)).resolves.toEqual({ ok: false, error: '视频记录不存在' })
    expect(mockElectron.openExternal).not.toHaveBeenCalled()
  })

  it('系统浏览器打开失败时返回明确错误', async () => {
    const { videoId, openVideoSource } = setup()
    mockElectron.openExternal.mockRejectedValueOnce(new Error('boom'))
    await expect(openVideoSource(videoId)).resolves.toEqual({ ok: false, error: '无法打开原视频' })
  })
})
