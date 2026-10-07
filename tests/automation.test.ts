import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, setTaskStatus } from '../src/main/db'
import {
  shouldRunFollow, runAutoFollow, noticeForEvent, FollowTracker, Notifier, AutoFollowTimer, taskLabel, loginItemFor, startHidden
} from '../src/main/automation'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 建任务会读设置（去重开关）；设置文件放到系统临时目录里一个不存在的位置，读不到就用默认值
vi.mock('electron', () => ({ app: { getPath: () => require('os').tmpdir() + '/vs-test-' + process.pid + '-automation' } }))

// 2026-10-07 自动化（功能 3）：托盘 + 系统通知 + 每天定时追更

const at = (s: string): Date => new Date(s) // 本地时间

describe('什么时候该追更', () => {
  const on = { autoFollowEnabled: true, autoFollowTime: '09:00' }
  it('没开 → 不跑', () => {
    expect(shouldRunFollow(at('2026-10-07T10:00:00'), { ...on, autoFollowEnabled: false }, null)).toBe(false)
  })
  it('还没到点 → 不跑；到点了、今天没跑过 → 跑', () => {
    expect(shouldRunFollow(at('2026-10-07T08:59:00'), on, null)).toBe(false)
    expect(shouldRunFollow(at('2026-10-07T09:00:00'), on, null)).toBe(true)
  })
  it('今天到点后已经跑过 → 不再跑；昨天跑的不算', () => {
    expect(shouldRunFollow(at('2026-10-07T15:00:00'), on, at('2026-10-07T09:01:00').toISOString())).toBe(false)
    expect(shouldRunFollow(at('2026-10-07T15:00:00'), on, at('2026-10-06T09:01:00').toISOString())).toBe(true)
  })
  it('错过了点（下午才开电脑）→ 开机后补跑一次', () => {
    expect(shouldRunFollow(at('2026-10-07T15:00:00'), on, at('2026-10-06T09:00:00').toISOString())).toBe(true)
  })
  it('时间写错了 → 不跑', () => {
    expect(shouldRunFollow(at('2026-10-07T15:00:00'), { ...on, autoFollowTime: '25:99' }, null)).toBe(false)
  })
})

describe('定时追更建任务', () => {
  let db: DatabaseSync
  beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db) })
  const kw: CreateTaskInput = {
    platform: 'douyin', type: 'keyword', query: '猫', filters: { timeRange: 'all', duration: 'all', targetCount: 20 },
    aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
  }
  const item = (id: string, secUid: string): VideoItem => ({
    awemeId: id, title: id, authorSecUid: secUid, authorNickname: '昵称' + secUid, authorHomeUrl: 'h',
    playUrl: 'p', coverUrl: '', width: 1, height: 1, durationSec: 1, publishTime: 1759000000, likes: 0
  })
  /** 两个作者：A 爬过主页（有 done 的作者任务），B 只是关键词搜索时顺带收进来的 */
  function seed(): void {
    const t = createTask(db, kw)
    insertVideos(db, [item('v1', 'MS4wLjABAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), item('v2', 'MS4wLjABAAAAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')], t, 'douyin')
    const home = createTask(db, { ...kw, type: 'author', query: 'MS4wLjABAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    setTaskStatus(db, home, 'done')
    db.prepare("UPDATE tasks SET finished_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(home)
  }

  it('只给爬过主页的作者建「只抓新视频」任务，条数按设置；建好就排队', () => {
    seed()
    const enqueue = vi.fn()
    const r = runAutoFollow(db, enqueue, { count: 30 })
    expect(r).toMatchObject({ authors: 1, created: 1, skipped: 0 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const row = db.prepare('SELECT type, query, filters FROM tasks WHERE id = ?').get(r.taskIds[0]) as { type: string; query: string; filters: string }
    expect(row.type).toBe('author')
    expect(row.query).toBe('MS4wLjABAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(JSON.parse(row.filters)).toMatchObject({ timeRange: 'custom', targetCount: 30 })
  })

  it('同一个作者已经在排队 → 跳过，不重复建', () => {
    seed()
    runAutoFollow(db, () => {}, { count: 20 })
    const r = runAutoFollow(db, () => {}, { count: 20 })
    expect(r).toMatchObject({ created: 0, skipped: 1 })
  })

  // 2026-10-07 挑作者：「只追标了定时追更的」——只给标了的建；标了但没爬过主页的也建（按全部抓，条数照设置）
  it('只追标了的作者：没标的不建；标了没爬过的按全部抓', () => {
    seed()
    db.prepare("UPDATE authors SET auto_follow = 1 WHERE sec_uid LIKE '%bbbb%'").run()
    const r = runAutoFollow(db, () => {}, { count: 5, scope: 'picked' })
    expect(r).toMatchObject({ authors: 1, created: 1 })
    const row = db.prepare('SELECT query, filters FROM tasks WHERE id = ?').get(r.taskIds[0]) as { query: string; filters: string }
    expect(row.query).toContain('bbbb')
    expect(JSON.parse(row.filters)).toMatchObject({ timeRange: 'all', targetCount: 5 })
  })

  it('没有爬过主页的作者 → 什么都不建', () => {
    expect(runAutoFollow(db, () => {}, { count: 20 })).toMatchObject({ authors: 0, created: 0 })
  })

  it('任务名：关键词带引号，作者主页显示昵称，话题带 #', () => {
    seed()
    const home = runAutoFollow(db, () => {}, { count: 20 }).taskIds[0]
    expect(taskLabel(db, home)).toBe('抖音 · 昵称MS4wLjABAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(taskLabel(db, createTask(db, kw))).toBe('抖音 · 「猫」')
    expect(taskLabel(db, createTask(db, { ...kw, type: 'hashtag', query: '美食' }))).toBe('抖音 · #美食')
  })
})

describe('通知文案', () => {
  const info = { label: '抖音 · 「猫」', platformName: '抖音' }
  it('抓完了：说抓到几条', () => {
    expect(noticeForEvent({ type: 'task:done', taskId: 1, fetched: 12 }, info)).toEqual({ title: '抓完了', body: '抖音 · 「猫」：抓到 12 条' })
  })
  it('没登录 / 要验证 / 限流 / 卡住：说怎么办', () => {
    expect(noticeForEvent({ type: 'task:paused', taskId: 1, reason: 'login_required' }, info)?.body).toContain('抖音没登录')
    expect(noticeForEvent({ type: 'task:paused', taskId: 1, reason: 'stalled_verify' }, info)?.title).toBe('需要验证')
    expect(noticeForEvent({ type: 'task:paused', taskId: 1, reason: 'risk' }, info)?.title).toBe('平台限流了')
    expect(noticeForEvent({ type: 'task:paused', taskId: 1, reason: 'stalled' }, info)?.title).toBe('任务卡住了')
  })
  it('自己点的暂停、进度事件 → 不通知', () => {
    expect(noticeForEvent({ type: 'task:paused', taskId: 1, reason: 'user' }, info)).toBeNull()
    expect(noticeForEvent({ type: 'task:progress', taskId: 1, fetched: 1, status: 'running' }, info)).toBeNull()
  })
})

describe('同一件事不刷屏', () => {
  it('一样的通知 10 分钟内只弹一次', () => {
    let now = 0
    const show = vi.fn()
    const n = new Notifier({ show, now: () => now })
    n.notify({ title: '需要登录', body: '抖音没登录' })
    n.notify({ title: '需要登录', body: '抖音没登录' })
    expect(show).toHaveBeenCalledTimes(1)
    now = 11 * 60 * 1000
    n.notify({ title: '需要登录', body: '抖音没登录' })
    expect(show).toHaveBeenCalledTimes(2)
  })
})

describe('定时追更汇总', () => {
  it('追更的任务各自抓完不单独弹，全部结束后弹一条汇总', () => {
    const t = new FollowTracker()
    t.start([1, 2])
    expect(t.owns(1)).toBe(true)
    expect(t.onEvent({ type: 'task:done', taskId: 1, fetched: 3 })).toBeNull()
    expect(t.onEvent({ type: 'task:progress', taskId: 2, fetched: 1, status: 'running' })).toBeNull()
    expect(t.onEvent({ type: 'task:paused', taskId: 2, reason: 'login_required' })).toEqual({
      title: '定时追更完成', body: '追了 2 个作者，新抓到 3 条；1 个没跑完，去任务列表看看'
    })
    expect(t.owns(1)).toBe(false)
  })
})

describe('定时器', () => {
  it('到点就跑一次并记下时间；跑完同一天不再跑', async () => {
    let last: string | null = null
    const run = vi.fn(async () => {})
    const timer = new AutoFollowTimer({
      getSchedule: () => ({ autoFollowEnabled: true, autoFollowTime: '09:00' }),
      getLastRun: () => last,
      setLastRun: v => { last = v },
      run,
      now: () => at('2026-10-07T09:30:00')
    })
    await timer.tick()
    await timer.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(last).not.toBeNull()
  })
})

// 2026-10-07 开机自动启动：打包版才写系统启动项；便携版要写原 exe 的路径（运行时的 exe 在临时目录，下次开机就没了）
describe('开机自动启动', () => {
  it('打包版：开 → 写启动项，带 --hidden（开机后缩在托盘）；关 → 撤掉', () => {
    expect(loginItemFor(true, { isPackaged: true, execPath: 'C:/tmp/x/视频爬取工具.exe' })).toEqual({
      openAtLogin: true, path: 'C:/tmp/x/视频爬取工具.exe', args: ['--hidden']
    })
    expect(loginItemFor(false, { isPackaged: true, execPath: 'C:/a.exe' })).toEqual({ openAtLogin: false, path: 'C:/a.exe', args: ['--hidden'] })
  })
  it('便携版：用原来那个 exe 的路径', () => {
    expect(loginItemFor(true, { isPackaged: true, execPath: 'C:/Temp/2abc/视频爬取工具.exe', portableFile: 'D:/工具/视频爬取工具.exe' })?.path)
      .toBe('D:/工具/视频爬取工具.exe')
  })
  it('开发版不碰系统启动项', () => {
    expect(loginItemFor(true, { isPackaged: false, execPath: 'electron.exe' })).toBeNull()
  })
  it('带 --hidden 启动 → 不弹主窗口', () => {
    expect(startHidden(['app.exe', '--hidden'])).toBe(true)
    expect(startHidden(['app.exe'])).toBe(false)
  })
})
