import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus, listAuthors } from '../src/main/db'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 2026-10-06 全面检查「数据安全」第三组：#10 删作者先取消下载；B5 已删除的视频不能被「重试」/删任务弄丢记号

const mockIpc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), trashItem: vi.fn(async () => {}) }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, fn: (...args: unknown[]) => unknown): void => { mockIpc.handlers.set(c, fn) }, on: () => {}, removeHandler: () => {} },
  app: { getPath: () => process.cwd() + '/.tmp-ipc-data-safety', getAppPath: () => '' },
  dialog: {}, clipboard: {},
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: mockIpc.trashItem }
}))
// 下载目录指到系统临时目录，测试不往仓库里写文件
const tmpDl = vi.hoisted(() => (require('fs') as typeof import('fs')).mkdtempSync((require('path') as typeof import('path')).join((require('os') as typeof import('os')).tmpdir(), 'ipc-data-safety-')))
vi.mock('../src/main/settings', async orig => {
  const real = await orig<typeof import('../src/main/settings')>()
  return { ...real, getSettings: () => ({ ...real.getSettings(), downloadDir: tmpDl }) }
})
import { registerIpc } from '../src/main/ipc'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll } from 'vitest'
afterAll(() => rmSync(tmpDl, { recursive: true, force: true }))

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (id: string, sec = 'SEC'): VideoItem => ({
  awemeId: id, title: '标题', authorSecUid: sec, authorNickname: '作者' + sec,
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 0, height: 0,
  durationSec: 10, publishTime: 1710000000, likes: 0, comments: null
})

function setup() {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  mockIpc.handlers.clear()
  const calls: string[] = []
  const downloader = {
    cancel: vi.fn((ids: number[]) => {
      const left = (db.prepare(`SELECT COUNT(*) c FROM videos WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { c: number }).c
      calls.push(`cancel:${ids.join(',')}:行还在${left}`)
    }),
    enqueue: vi.fn((id: number) => calls.push(`enqueue:${id}`))
  }
  registerIpc({
    db, scheduler: { currentTaskId: 0, isRunning: false, pause: vi.fn(), resume: vi.fn(), run: vi.fn() } as never,
    downloader: downloader as never, analyzer: null, browser: {} as never, getWindow: () => ({}) as never,
    reloadAnalyzer: () => {}, reloadOrganizer: () => {}, getOrganizer: () => null,
    enqueueTask: () => {}, dequeueTask: () => {}, kickQueue: () => {}, setBrowserVisible: () => {}
  } as never)
  const call = (ch: string, ...args: unknown[]) => mockIpc.handlers.get(ch)!(null, ...args)
  return { db, calls, downloader, call }
}

beforeEach(() => { mockIpc.handlers.clear(); mockIpc.trashItem.mockReset(); mockIpc.trashItem.mockImplementation(async () => {}) })

describe('#10 删作者先停掉他的下载', () => {
  it('先取消这个作者在下载 / 排队的视频，再删数据；别的作者不受影响', async () => {
    const { db, calls, call } = setup()
    const taskId = createTask(db, input)
    insertVideos(db, [item('A1', 'S1'), item('A2', 'S1'), item('B1', 'S2')], taskId, 'douyin')
    const s1 = listAuthors(db).find(a => a.sec_uid === 'S1')!
    const ids = listVideos(db, taskId).filter(v => v.author_id === s1.id).map(v => v.id)
    await call('authors:delete', [s1.id])
    expect(calls).toEqual([`cancel:${ids.join(',')}:行还在2`])
    expect(listAuthors(db).map(a => a.sec_uid)).toEqual(['S2'])
  })
})

describe('B5 已删除的视频', () => {
  it('「重试」对已删除的视频不起作用（不会被重新下载）', async () => {
    const { db, calls, call } = setup()
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [a, b] = listVideos(db, taskId)
    setVideoStatus(db, a.id, 'deleted')
    setVideoStatus(db, b.id, 'failed')
    await call('video:retry', [a.id, b.id])
    expect(calls).toEqual([`enqueue:${b.id}`])
    expect(db.prepare('SELECT status FROM videos WHERE id = ?').get(a.id)).toEqual({ status: 'deleted' })
  })

  it('删任务时保留「已删除」记号（否则重搜又会下回来）', async () => {
    const { db, call } = setup()
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [a] = listVideos(db, taskId)
    setVideoStatus(db, a.id, 'deleted')
    await call('task:delete', taskId)
    expect(db.prepare('SELECT aweme_id, status FROM videos').all()).toEqual([{ aweme_id: 'A', status: 'deleted' }])
  })

  it('文件早被手动删了 → 不去回收站找，照样把记录标成已删除', async () => {
    const { db, call } = setup()
    const taskId = createTask(db, input)
    insertVideos(db, [item('GONE')], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    setVideoStatus(db, v.id, 'done', { local_path: join(tmpDl, '早没了.mp4') })
    mockIpc.trashItem.mockRejectedValue(new Error('Failed to move item to trash')) // 真的去回收站找会这样报错
    expect(await call('video:delete', [v.id])).toEqual({ ok: true, deleted: 1 })
    expect(mockIpc.trashItem).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status FROM videos WHERE id = ?').get(v.id)).toEqual({ status: 'deleted' })
  })

  it('程序里删视频：文件进回收站（shell.trashItem）', async () => {
    const { db, call } = setup()
    const taskId = createTask(db, input)
    insertVideos(db, [item('A')], taskId, 'douyin')
    const [a] = listVideos(db, taskId)
    const p = join(tmpDl, 'A.mp4')
    writeFileSync(p, 'mp4')
    setVideoStatus(db, a.id, 'done', { local_path: p })
    expect(await call('video:delete', [a.id])).toEqual({ ok: true, deleted: 1 })
    expect(mockIpc.trashItem).toHaveBeenCalledWith(p)
  })
})
