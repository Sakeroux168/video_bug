import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Scheduler as RealScheduler } from '../src/main/scheduler'
import { createTask, initDb } from '../src/main/db'
import { xiaohongshuAdapter as adapter } from '../src/main/adapters/xiaohongshu'
import type { VideoBrowser } from '../src/main/browser'
import type { Downloader } from '../src/main/downloader'

// 测试里的浏览器 / 下载器 / AI 是只实现了用到那几个方法的替身；构造调度器时放宽这三个依赖的类型
type SchedulerDepsForTest = Omit<ConstructorParameters<typeof RealScheduler>[0], 'browser' | 'downloader' | 'analyzer'> &
  { browser: unknown; downloader: unknown; analyzer: unknown }
const Scheduler = RealScheduler as unknown as new (deps: SchedulerDepsForTest) => RealScheduler
type Scheduler = RealScheduler

vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-xhs-test' } }))
const searchUrl = '//so.xiaohongshu.com/api/sns/web/v2/search/notes'
const detailUrl = '//edith.xiaohongshu.com/api/sns/web/v1/feed'
const list = (ids: string[], hasMore = false, type = 'video') => ({ data: {
  has_more: hasMore, items: ids.map(id => ({ id, model_type: 'note', xsec_token: 'PRIVATE_TOKEN',
    note_card: { type, display_title: id } }))
} })
const detail = (id: string, duration = 12) => ({ data: { items: [{ id, note_card: {
  note_id: id, type: 'video', title: id, time: 1780000000000,
  user: { user_id: 'AUTHOR', nickname: '作者' },
  video: { capa: { duration }, media: { stream: { EF4: [{ width: 720, height: 1280,
    master_url: 'https://cdn.test/video.mp4' }] } } }
} }] } })

function setup(target = 2, autoDownload = true, detailTimeoutMs = 50) {
  const db = new DatabaseSync(':memory:'); initDb(db)
  const id = createTask(db, { platform: 'xiaohongshu', type: 'keyword', query: '美食',
    filters: { timeRange: 'all', duration: 'all', targetCount: target },
    aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload })
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
    getStallThresholdSec: () => 1, detailTimeoutMs })
  const rows = () => db.prepare('SELECT * FROM videos').all()
  const state = () => db.prepare('SELECT status, fetched_count, error FROM tasks WHERE id=?').get(id)
  return { db, id, s, browser, downloader, rows, state, logs, events }
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('小红书搜索 → 详情 → 保存', () => {
  it('详情接口不触发时从当前页面 INITIAL_STATE 取得详情并保存', async () => {
    const t = setup(1)
    const pageItem = adapter.parseDetail!(detail('PAGE'))!
    Object.assign(t.browser, { extractCurrentDetail: vi.fn(async (_a: unknown, noteId: string) => noteId === 'PAGE' ? pageItem : null) })
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['PAGE']))
      else await new Promise<void>(() => {})
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['PAGE'])
    expect(t.browser.stopLoading).toHaveBeenCalled()
    expect(JSON.stringify(t.rows()) + t.logs.join('')).not.toContain('PRIVATE_TOKEN')
    t.db.close()
  })

  it('网页筛选前的首屏候选会清空，只处理筛选刷新后的结果', async () => {
    const t = setup(1)
    Object.assign(t.browser, { applyNativeSearchFilters: vi.fn(async (filters: unknown) => {
      expect(filters).toEqual([{ group: '笔记类型', option: '视频' }])
      await t.s.handleRaw(adapter, searchUrl, list(['NEW']))
      return { applied: true, noteIds: ['NEW'] }
    }) })
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['OLD']))
      else await t.s.handleRaw(adapter, detailUrl, detail(new URL(url!).pathname.split('/').pop()!))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(100); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['NEW'])
    expect(t.logs.join('')).toContain('笔记类型=视频')
    t.db.close()
  })

  it('列表去重且不入库；只认当前详情；达到数量后下载并结束；token 不持久化', async () => {
    const t = setup()
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) {
        await t.s.handleRaw(adapter, detailUrl, detail('USER_CLICK'))
        await t.s.handleRaw(adapter, searchUrl, list(['N1', 'N1', 'N2', 'N3'], true))
        expect(t.rows()).toEqual([])
      } else {
        const id = new URL(url!).pathname.split('/').pop()!
        await t.s.handleRaw(adapter, detailUrl, detail('UNRELATED'))
        await t.s.handleRaw(adapter, detailUrl, detail(id))
        await t.s.handleRaw(adapter, detailUrl, detail(id))
      }
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['N1', 'N2'])
    expect(t.browser.load).toHaveBeenCalledTimes(3)
    expect(t.downloader.enqueue).toHaveBeenCalledTimes(2)
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 2 })
    expect(JSON.stringify(t.rows()) + t.logs.join('')).not.toContain('PRIVATE_TOKEN')
    t.db.close()
  })

  it('详情超时、加载失败或不可解析时逐条跳过，不阻塞后续笔记', async () => {
    const t = setup(4)
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['TIMEOUT', 'FAIL', 'BAD', 'OK']))
      if (url?.includes('/FAIL?')) throw new Error('url?xsec_token=PRIVATE_TOKEN')
      if (url?.includes('/BAD?')) await t.s.handleRaw(adapter, detailUrl, { data: { items: [{ id: 'BAD', note_card: { note_id: 'BAD', type: 'video' } }] } })
      if (url?.includes('/OK?')) await t.s.handleRaw(adapter, detailUrl, detail('OK'))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.rows().map(r => r.aweme_id)).toEqual(['OK'])
    expect(t.logs.join('')).toMatch(/超时/)
    expect(t.logs.join('')).toMatch(/解析/)
    expect(t.logs.join('')).not.toContain('PRIVATE_TOKEN')
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 1 })
    t.db.close()
  })

  it.each(['pause', 'stop'] as const)('%s 中断挂起的详情导航；迟到响应不入库', async action => {
    const t = setup(1)
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['N1']))
      else await new Promise<void>(() => {})
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(5)
    expect(t.browser.load).toHaveBeenCalledTimes(2)
    await t.s[action](); await run
    await t.s.handleRaw(adapter, detailUrl, detail('N1'))
    expect(t.rows()).toEqual([])
    expect(t.browser.stopLoading).toHaveBeenCalled()
    expect(t.state()).toMatchObject({ status: 'paused', fetched_count: 0 })
    expect(t.s.isRunning).toBe(false)
    t.db.close()
  })

  it('只有图文但仍有下一页时继续滚；最后一页视频进入详情并应用时长过滤、手动收集', async () => {
    const t = setup(3, false)
    t.db.prepare('UPDATE tasks SET filters=? WHERE id=?').run(JSON.stringify({ timeRange: 'all', duration: 'under30', targetCount: 3 }), t.id)
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['IMG'], true, 'normal'))
      else await t.s.handleRaw(adapter, detailUrl, detail(url?.includes('/LONG?') ? 'LONG' : 'SHORT', url?.includes('/LONG?') ? 100 : 12))
    })
    t.browser.scrollToBottom.mockImplementation(async () => {
      await t.s.handleRaw(adapter, searchUrl, list(['LONG', 'SHORT']))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(500); await run
    expect(t.browser.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(t.rows()).toHaveLength(1)
    expect(t.rows()[0]).toMatchObject({ aweme_id: 'SHORT', status: 'collected' })
    expect(t.downloader.enqueue).not.toHaveBeenCalled()
    t.db.close()
  })

  it('详情页验证码出现后立即暂停，不继续导航或入库', async () => {
    const t = setup(2, true, 30000)
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['N1', 'N2']))
      else t.browser.findVerifyIndicator.mockResolvedValue('请完成验证')
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(1100); await run
    expect(t.state()).toMatchObject({ status: 'paused', error: 'stalled_verify' })
    expect(t.browser.load).toHaveBeenCalledTimes(2)
    expect(t.rows()).toEqual([])
    t.db.close()
  })

  it('未登录提示独立暂停并提示先登录小红书，不误报验证码', async () => {
    const t = setup(1, true, 30000)
    t.browser.findLoginIndicator.mockResolvedValue('登录后查看搜索结果')
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(2100); await run
    expect(t.state()).toMatchObject({ status: 'paused', error: 'login_required' })
    expect(t.events).toContainEqual({ type: 'task:paused', taskId: t.id, reason: 'login_required' })
    expect(t.events).toContainEqual({ type: 'task:notice', text: '请先在内置浏览器登录 小红书' })
    expect(t.events).not.toContainEqual(expect.objectContaining({ reason: 'stalled_verify' }))
    t.db.close()
  })

  it('继续任务跳过已入库的笔记，重新收集令牌，只补齐剩余数量', async () => {
    const t = setup(2)
    let complete = false
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['N1', 'N2', 'N3']))
      else if (url?.includes('/N1?') || complete) {
        await t.s.handleRaw(adapter, detailUrl, detail(new URL(url!).pathname.split('/').pop()!))
      }
    })
    const first = t.s.run(t.id); await vi.advanceTimersByTimeAsync(5)
    await t.s.pause(); await first
    expect(t.rows().map(r => r.aweme_id)).toEqual(['N1'])
    complete = true
    const second = t.s.resume(t.id); await vi.advanceTimersByTimeAsync(100); await second
    expect(t.rows().map(r => r.aweme_id)).toEqual(['N1', 'N2'])
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 2 })
    expect(t.downloader.enqueue).toHaveBeenCalledTimes(2)
    t.db.close()
  })

  it('列表阶段暂停后、任务完成后，流量均不能污染数据库', async () => {
    const t = setup()
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(1)
    await t.s.pause(); await run
    expect(await t.s.handleRaw(adapter, searchUrl, list(['N1']))).toBeNull()
    expect(await t.s.handleRaw(adapter, detailUrl, detail('N1'))).toBeNull()
    expect(t.rows()).toEqual([])
    t.db.close()
  })

  it('列表到底不足目标也处理已有候选；空列表确认结束可完成', async () => {
    const t = setup(5)
    t.browser.findBottomText.mockResolvedValue('没有更多了')
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('search_result')) await t.s.handleRaw(adapter, searchUrl, list(['N1'], true))
      else await t.s.handleRaw(adapter, detailUrl, detail('N1'))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(100); await run
    expect(t.rows()).toHaveLength(1)
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 1 })
    t.db.close()
    const empty = setup()
    empty.browser.load.mockImplementation(async () => { await empty.s.handleRaw(adapter, searchUrl, list([])) })
    await empty.s.run(empty.id)
    expect(empty.state()).toMatchObject({ status: 'done', fetched_count: 0 })
    empty.db.close()
  })

  it('无响应时暂停且不伪报完成', async () => {
    const t = setup()
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(14000); await run
    expect(t.state()).toMatchObject({ status: 'paused', error: 'stalled' })
    t.db.close()
  })

  it('作者主页从 DOM 视频卡片取得 pc_user 令牌，再走同一详情保存流程', async () => {
    const t = setup(1)
    t.db.prepare("UPDATE tasks SET type='author', query='AUTHOR' WHERE id=?").run(t.id)
    const authorStub = {
      noteId: 'A1', detailToken: 'AUTHOR_TOKEN', detailSource: 'pc_user',
      detailUrl: 'https://www.xiaohongshu.com/user/profile/AUTHOR/A1?xsec_token=AUTHOR_TOKEN&xsec_source=pc_user',
      title: '作者视频', authorId: 'AUTHOR', authorNickname: '', coverUrl: '', likes: null, comments: null
    }
    Object.assign(t.browser, { collectListStubs: vi.fn(async () => ({ stubs: [authorStub], skipped: { image: 0, other: 0 } })) })
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('/AUTHOR/A1?')) await t.s.handleRaw(adapter, detailUrl, detail('A1'))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(100); await run
    expect(t.browser.load).toHaveBeenNthCalledWith(1, adapter, 'https://www.xiaohongshu.com/user/profile/AUTHOR')
    expect(t.browser.load).toHaveBeenNthCalledWith(2, adapter, authorStub.detailUrl)
    expect(t.rows().map(r => r.aweme_id)).toEqual(['A1'])
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 1 })
    expect(JSON.stringify(t.rows()) + t.logs.join('')).not.toContain('AUTHOR_TOKEN')
    t.db.close()
  })

  describe('追更（作者主页 + 起始日期）：连续碰到比起点还旧的作品就收尾', () => {
    const NEW = Date.UTC(2026, 9, 1) // 2026-10-01
    const OLD = Date.UTC(2026, 8, 1) // 2026-09-01
    const timed = (id: string, time: number) => {
      const d = detail(id) as { data: { items: Array<{ note_card: { time: number } }> } }
      d.data.items[0].note_card.time = time
      return d
    }
    function authorRange(target: number, notes: Array<[string, number]>) {
      const t = setup(target)
      t.db.prepare("UPDATE tasks SET type='author', query='AUTHOR', filters=? WHERE id=?")
        .run(JSON.stringify({ timeRange: 'custom', startDate: '2026-09-25', duration: 'all', targetCount: target }), t.id)
      const stubs = notes.map(([id]) => ({
        noteId: id, detailToken: 'TK', detailSource: 'pc_user',
        detailUrl: `https://www.xiaohongshu.com/user/profile/AUTHOR/${id}?xsec_token=TK&xsec_source=pc_user`,
        title: id, authorId: 'AUTHOR', authorNickname: '', coverUrl: '', likes: null, comments: null
      }))
      Object.assign(t.browser, { collectListStubs: vi.fn(async () => ({ stubs, skipped: { image: 0, other: 0 } })) })
      const visited: string[] = []
      t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
        const m = /\/AUTHOR\/([^?]+)\?/.exec(url ?? '')
        if (!m) return
        visited.push(m[1])
        await t.s.handleRaw(adapter, detailUrl, timed(m[1], notes.find(([id]) => id === m[1])![1]))
      })
      return { ...t, visited }
    }

    it('只有 1 条新的、后面全是旧的 → 连续看到 4 条旧作品就收尾，不再挨个打开剩下的候选', async () => {
      const t = authorRange(5, [['N1', NEW], ['O1', OLD], ['O2', OLD], ['O3', OLD], ['O4', OLD], ['O5', OLD], ['O6', OLD], ['O7', OLD]])
      const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(20000); await run
      expect(t.rows().map(r => r.aweme_id)).toEqual(['N1'])
      expect(t.visited).toEqual(['N1', 'O1', 'O2', 'O3', 'O4'])
      expect(t.state()).toMatchObject({ status: 'done', fetched_count: 1 })
      t.db.close()
    })

    it('前 3 条是置顶的旧笔记 → 不能被它们骗得提前收尾，后面的新作品照样抓到', async () => {
      const t = authorRange(5, [['P1', OLD], ['P2', OLD], ['P3', OLD], ['N1', NEW], ['N2', NEW],
        ['O1', OLD], ['O2', OLD], ['O3', OLD], ['O4', OLD], ['O5', OLD]])
      const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(20000); await run
      expect(t.rows().map(r => r.aweme_id).sort()).toEqual(['N1', 'N2'])
      expect(t.visited).toEqual(['P1', 'P2', 'P3', 'N1', 'N2', 'O1', 'O2', 'O3', 'O4'])
      expect(t.state()).toMatchObject({ status: 'done', fetched_count: 2 })
      t.db.close()
    })
  })

  it('作者作品少于目标时，重复 DOM 卡片不刷新停滞计时，已有候选仍会收尾', async () => {
    const t = setup(2)
    t.db.prepare("UPDATE tasks SET type='author', query='AUTHOR' WHERE id=?").run(t.id)
    const stub = {
      noteId: 'ONLY', detailToken: 'T', detailSource: 'pc_user',
      detailUrl: 'https://www.xiaohongshu.com/user/profile/AUTHOR/ONLY?xsec_token=T&xsec_source=pc_user',
      title: '', authorId: 'AUTHOR', authorNickname: '', coverUrl: '', likes: null, comments: null
    }
    const collect = vi.fn(async () => ({ stubs: [stub], skipped: { image: 0, other: 0 } }))
    Object.assign(t.browser, { collectListStubs: collect })
    t.browser.load.mockImplementation(async (_a?: unknown, url?: string) => {
      if (url?.includes('/AUTHOR/ONLY?')) await t.s.handleRaw(adapter, detailUrl, detail('ONLY'))
    })
    const run = t.s.run(t.id); await vi.advanceTimersByTimeAsync(20000); await run
    expect(collect.mock.calls.length).toBeGreaterThan(1)
    expect(t.rows().map(r => r.aweme_id)).toEqual(['ONLY'])
    expect(t.state()).toMatchObject({ status: 'done', fetched_count: 1 })
    t.db.close()
  })
})
