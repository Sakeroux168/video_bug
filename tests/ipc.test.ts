import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask } from '../src/main/db'

// 主进程 IPC 通道在 node 环境无法真实起用：vi.hoisted 造一个假 ipcMain（handle 注册的处理函数
// 记入 handlers），再 mock electron 让 registerIpc 注册到它上面，测试里直接调用 handler。
const mockIpc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown): void => { handlers.set(channel, fn) },
      on: () => {},
      removeHandler: () => {}
    }
  }
})
vi.mock('electron', () => ({
  ipcMain: mockIpc.ipcMain,
  app: { getPath: () => 'mock-path', getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

/** registerIpc 注册到假 ipcMain 上的处理函数表（debug:testFilter 从这里取） */
const mockHandlers = mockIpc.handlers

function busyError(): Error & { code: string } {
  return Object.assign(new Error('filter_busy'), { code: 'FILTER_BUSY' })
}

describe('debug:testFilter 互斥锁被拒文案', () => {
  beforeEach(() => { mockHandlers.clear() })

  it('browser 抛 FILTER_BUSY 时返回「已有筛选流程进行中，本次跳过」并打日志', async () => {
    const db = new DatabaseSync(':memory:')
    initDb(db)
    const taskId = createTask(db, {
      platform: 'douyin', type: 'keyword', query: '测试',
      filters: {
        timeRange: 'all', duration: 'all', targetCount: 200,
        douyinFilter: { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }
      },
      aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
    })
    // debug:testFilter 只认 running/paused 的 keyword 任务
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId)

    const logs: string[] = []
    const browser = { applyDouyinFilter: vi.fn(async () => { throw busyError() }) }
    registerIpc({
      db,
      scheduler: {} as never,
      downloader: {} as never,
      analyzer: null,
      browser: browser as never,
      getWindow: () => ({}) as never,
      reloadAnalyzer: () => {},
      reloadOrganizer: () => {},
      getOrganizer: () => null,
      enqueueTask: () => {},
      setBrowserVisible: () => {},
      pushFilterLog: (m: string) => logs.push(m)
    })

    const fn = mockHandlers.get('debug:testFilter')
    expect(fn).toBeDefined()
    const r = (await fn!()) as { ok: boolean; message: string }
    expect(r).toEqual({ ok: false, message: '已有筛选流程进行中，本次跳过' })
    expect(logs.join('\n')).toContain('手动测试筛选：已有筛选流程进行中，本次跳过')
    expect(browser.applyDouyinFilter).toHaveBeenCalledTimes(1)
  })

  it('silent=true 时流程日志回调丢弃（不进 rawLog），其余行为一致', async () => {
    const db = new DatabaseSync(':memory:')
    initDb(db)
    const taskId = createTask(db, {
      platform: 'douyin', type: 'keyword', query: '测试',
      filters: {
        timeRange: 'all', duration: 'all', targetCount: 200,
        douyinFilter: { enabled: true, publishTime: 0, duration: 1, searchScope: 0, contentType: 0 }
      },
      aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
    })
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId)

    const logs: string[] = []
    const browser = { applyDouyinFilter: vi.fn(async () => true) }
    registerIpc({
      db,
      scheduler: {} as never,
      downloader: {} as never,
      analyzer: null,
      browser: browser as never,
      getWindow: () => ({}) as never,
      reloadAnalyzer: () => {},
      reloadOrganizer: () => {},
      getOrganizer: () => null,
      enqueueTask: () => {},
      setBrowserVisible: () => {},
      pushFilterLog: (m: string) => logs.push(m)
    })

    const fn = mockHandlers.get('debug:testFilter')
    expect(fn).toBeDefined()
    // handler 签名是 (event, opts)，测试直接调用需补一个假 event 占位
    const r = (await fn!(null, { silent: true })) as { ok: boolean; message: string }
    // 结果与带日志版一致
    expect(r).toEqual({ ok: true, message: '筛选执行成功，详见「查看拦截日志」' })
    expect(browser.applyDouyinFilter).toHaveBeenCalledTimes(1)
    // 静默：传下去的日志回调是空函数，调用也不产生 rawLog 行
    const cb = vi.mocked(browser.applyDouyinFilter).mock.calls[0][2] as (m: string) => void
    cb('手动测试筛选：任务执行中')
    expect(logs).toEqual([])
  })

  it('无可用任务时返回提示且不调 browser', async () => {
    const db = new DatabaseSync(':memory:')
    initDb(db)
    const logs: string[] = []
    const browser = { applyDouyinFilter: vi.fn(async () => true) }
    registerIpc({
      db,
      scheduler: {} as never,
      downloader: {} as never,
      analyzer: null,
      browser: browser as never,
      getWindow: () => ({}) as never,
      reloadAnalyzer: () => {},
      reloadOrganizer: () => {},
      getOrganizer: () => null,
      enqueueTask: () => {},
      setBrowserVisible: () => {},
      pushFilterLog: (m: string) => logs.push(m)
    })

    const fn = mockHandlers.get('debug:testFilter')
    const r = (await fn!()) as { ok: boolean; message: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('无可用任务')
    expect(browser.applyDouyinFilter).not.toHaveBeenCalled()
  })
})
