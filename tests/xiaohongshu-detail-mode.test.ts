import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Scheduler } from '../src/main/scheduler'
import { createTask, initDb } from '../src/main/db'
import { xiaohongshuAdapter as adapter } from '../src/main/adapters/xiaohongshu'
import type { VideoBrowser } from '../src/main/browser'
import type { Downloader } from '../src/main/downloader'
import type { Filters } from '../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() + '/.tmp-xhs-mode-test' } }))

const searchUrl = '//so.xiaohongshu.com/api/sns/web/v2/search/notes'
const list = (ids: string[], hasMore = false) => ({ data: {
  has_more: hasMore, items: ids.map(id => ({ id, model_type: 'note', xsec_token: 'PRIVATE_TOKEN',
    note_card: { type: 'video', display_title: id } }))
} })

/** 与真机快速模式一致的详情页 HTML（非标准 JSON：undefined / new Map） */
const fastDetailHtml = (noteId: string): string => `<!doctype html><html><head><title>${noteId}</title></head><body><script>window.__INITIAL_STATE__={
  "note": {
    "currentNoteId": "${noteId}",
    "noteDetailMap": { "${noteId}": { "note": {
      "noteId": "${noteId}", "type": "video", "title": "快速-${noteId}", "desc": "", "time": 1780000000000,
      "user": { "userId": "AUTHOR1", "nickname": "作者甲", "nickName": undefined },
      "interactInfo": { "likedCount": "12", "commentCount": "3" },
      "extraIndex": new Map([]),
      "video": { "capa": { "duration": 8 }, "media": { "stream": {
        "EF4": [{ "masterUrl": "https://sns-video-zl.xhscdn.com/${noteId}.mp4", "width": 720, "height": 1280, "avgBitrate": 900, "videoCodec": "EF4", "duration": 8000 }]
      } } }
    }, "comments": undefined } }
  }
};</script></body></html>`

function setup(target: number, detailMode?: 'safe' | 'fast', opts?: { detailTimeoutMs?: number }) {
  const db = new DatabaseSync(':memory:'); initDb(db)
  const filters: Filters = { timeRange: 'all', duration: 'all', targetCount: target }
  if (detailMode) filters.detailMode = detailMode
  const id = createTask(db, { platform: 'xiaohongshu', type: 'keyword', query: '美食',
    filters, aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true })
  const logs: string[] = []
  const events: unknown[] = []
  const browser = { load: vi.fn(async () => {}), scrollToBottom: vi.fn(async () => {}),
    abortScroll: vi.fn(), stopLoading: vi.fn(), findBottomText: vi.fn(async (): Promise<string | null> => null),
    findVerifyIndicator: vi.fn(async (): Promise<string | null> => null),
    findLoginIndicator: vi.fn(async (): Promise<string | null> => null) }
  const downloader = { onEvent: vi.fn(), enqueue: vi.fn() }
  const s = new Scheduler({ db, browser: browser as unknown as VideoBrowser,
    downloader: downloader as unknown as Downloader, analyzer: null,
    emit: e => events.push(e), onFilterLog: m => logs.push(m),
    getScrollParams: () => ({ scrollSpeed: 'fast', scrollPageWaitMs: 1, scrollIntervalMs: 1 }),
    getStallThresholdSec: () => 1,
    detailTimeoutMs: opts?.detailTimeoutMs })
  const rows = () => db.prepare('SELECT * FROM videos').all()
  const state = () => db.prepare('SELECT status, fetched_count, error FROM tasks WHERE id=?').get(id)
  return { db, id, s, browser, downloader, rows, state, logs, events }
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('快速模式（detailMode=fast）：详情走 session fetch，不导航窗口', () => {
  it('两条详情都从 fetchDetailHtml 解析入库；窗口只加载搜索页一次', async () => {
    const t = setup(2, 'fast')
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['F1', 'F2']))
    })
    t.browser.fetchDetailHtml = vi.fn(async (_a: unknown, url: string) => {
      const noteId = new URL(url).pathname.split('/').pop()!
      return { status: 200, finalUrl: url, body: fastDetailHtml(noteId) }
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['F1', 'F2'])
    expect(t.browser.load).toHaveBeenCalledTimes(1)
    expect(t.browser.fetchDetailHtml).toHaveBeenCalledTimes(2)
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 2 })
    // 令牌不进日志
    expect(t.logs.join('')).not.toContain('PRIVATE_TOKEN')
    t.db.close()
  })

  it('响应重定向到登录页 → 任务以 login_required 暂停', async () => {
    const t = setup(1, 'fast')
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['L1']))
    })
    t.browser.fetchDetailHtml = vi.fn(async (_a: unknown, url: string) =>
      ({ status: 302, finalUrl: 'https://www.xiaohongshu.com/login?redirect=x', body: '<html></html>' }))
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.state()).toMatchObject({ status: 'paused', error: 'login_required' })
    expect(t.rows()).toEqual([])
    t.db.close()
  })

  it('响应是验证码页 → 任务以 stalled_verify 暂停', async () => {
    const t = setup(1, 'fast')
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['V1']))
    })
    t.browser.fetchDetailHtml = vi.fn(async () =>
      ({ status: 200, finalUrl: 'https://www.xiaohongshu.com/web/captcha', body: '<title>安全验证</title>' }))
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.state()).toMatchObject({ status: 'paused', error: 'stalled_verify' })
    t.db.close()
  })

  it('解析失败写脱敏诊断并跳过该条，继续下一条', async () => {
    const t = setup(2, 'fast')
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['BAD', 'GOOD']))
    })
    t.browser.fetchDetailHtml = vi.fn(async (_a: unknown, url: string) => {
      const noteId = new URL(url).pathname.split('/').pop()!
      if (noteId === 'BAD') return { status: 200, finalUrl: url, body: '<html><body>响应体内容不能进日志</body></html>' }
      return { status: 200, finalUrl: url, body: fastDetailHtml(noteId) }
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['GOOD'])
    expect(t.logs.join('')).toMatch(/BAD/)
    expect(t.logs.join('')).not.toContain('响应体内容不能进日志')
    t.db.close()
  })

  it('稳妥默认：不设 detailMode 时仍走窗口导航', async () => {
    const t = setup(1)
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['S1']))
    })
    t.browser.fetchDetailHtml = vi.fn(async () => ({ status: 200, finalUrl: 'x', body: 'x' }))
    const run = t.s.run(t.id)
    await vi.advanceTimersByTimeAsync(200)
    expect(t.browser.fetchDetailHtml).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(31000) // 无提取器时详情等默认 30 秒超时跳过
    await run
    expect(t.browser.load).toHaveBeenCalledTimes(2) // 搜索页 + 详情页
    t.db.close()
  })
})

describe('稳妥模式提速（mainFrame.executeJavaScript）', () => {
  it('不再为小红书安排 15 秒 stopLoading 兜底；详情超时恢复默认 30 秒', async () => {
    const t = setup(1)
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['SLOW']))
      else await new Promise<void>(() => {}) // 详情页一直挂着资源，loadURL 不结束
    })
    Object.assign(t.browser, { extractCurrentDetail: vi.fn(async (): Promise<null> => null) })
    const run = t.s.run(t.id)
    await vi.advanceTimersByTimeAsync(16000)
    // 旧实现在 15 秒会 stop 一次；提速后注水状态用 mainFrame 读，不需要中断加载
    expect(t.browser.stopLoading).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15000) // 累计 31 秒 > 30 秒默认超时
    expect(t.logs.join('')).toMatch(/详情超时/)
    await run
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 0 })
    t.db.close()
  })

  it('mainFrame 读到注水状态即完成详情，不必等页面停止加载', async () => {
    const t = setup(1, undefined, { detailTimeoutMs: 30000 })
    t.browser.load.mockImplementation(async (_a: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['M1']))
      else await new Promise<void>(() => {})
    })
    Object.assign(t.browser, { extractCurrentDetail: vi.fn(async (_a: unknown, noteId: string) => ({
      awemeId: noteId, title: noteId, authorSecUid: 'A', authorNickname: 'n', authorHomeUrl: '',
      playUrl: 'https://cdn.test/v.mp4', coverUrl: '', width: 720, height: 1280, durationSec: 8,
      publishTime: 1780000000, likes: 1, comments: 1, sourceUrl: ''
    })) })
    const run = t.s.run(t.id)
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.rows().map(r => r.aweme_id)).toEqual(['M1'])
    await run
    t.db.close()
  })
})
