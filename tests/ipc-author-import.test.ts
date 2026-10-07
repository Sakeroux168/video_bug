import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'fs'
import { initDb, listAuthors } from '../src/main/db'

// authors:import IPC handler：批量导入作者（渲染层已过滤空行/纯空白，主进程仍需兜底校验）。
// mock electron：app.getPath 指向本测试专属临时目录（settings.json 可写；本测试用不到但 registerIpc 依赖 getSettings）
const mockIpc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    userData: require('os').tmpdir() + '/vs-test-' + process.pid + '-ipc-author-import',
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown): void => { handlers.set(channel, fn) },
      on: () => {},
      removeHandler: () => {}
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: mockIpc.ipcMain,
  app: { getPath: () => mockIpc.userData, getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

type ImportItem = { nickname: string; url: string }
type ImportResult = { created: number; results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> }

function setup(): { db: DatabaseSync; importAuthors: (items: ImportItem[]) => Promise<ImportResult> } {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  mockIpc.handlers.clear()
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
    processor: {} as never, dequeueTask: () => {}, kickQueue: () => {}, followNow: () => null
  })
  const handler = mockIpc.handlers.get('authors:import')!
  return {
    db,
    importAuthors: (items) => handler(null, items) as Promise<ImportResult>
  }
}

describe('authors:import', () => {
  beforeEach(() => { mkdirSync(mockIpc.userData, { recursive: true }) })
  afterEach(() => { rmSync(mockIpc.userData, { recursive: true, force: true }) })

  it('正常导入：完整 URL + 裸 sec_uid 各一条，均成功，created=2，home_url 存归一化后的地址', async () => {
    const { db, importAuthors } = setup()
    const r = await importAuthors([
      { nickname: '作者A', url: 'https://www.douyin.com/user/SEC_A' },
      { nickname: '作者B', url: 'SEC_B' }
    ])
    expect(r.created).toBe(2)
    expect(r.results).toEqual([
      { line: 1, raw: 'https://www.douyin.com/user/SEC_A', ok: true },
      { line: 2, raw: 'SEC_B', ok: true }
    ])
    const authors = listAuthors(db).sort((a, b) => a.sec_uid.localeCompare(b.sec_uid))
    expect(authors).toHaveLength(2)
    expect(authors[0]).toMatchObject({ sec_uid: 'SEC_A', nickname: '作者A', home_url: 'https://www.douyin.com/user/SEC_A', video_count: 0 })
    expect(authors[1]).toMatchObject({ sec_uid: 'SEC_B', nickname: '作者B', home_url: 'https://www.douyin.com/user/SEC_B', video_count: 0 })
  })

  it('缺少作者名称：nickname 为空/纯空白 → 该行标记失败，reason=缺少作者名称', async () => {
    const { importAuthors } = setup()
    const r = await importAuthors([
      { nickname: '', url: 'https://www.douyin.com/user/SEC_C' },
      { nickname: '   ', url: 'https://www.douyin.com/user/SEC_D' }
    ])
    expect(r.created).toBe(0)
    expect(r.results).toEqual([
      { line: 1, raw: 'https://www.douyin.com/user/SEC_C', ok: false, reason: '缺少作者名称' },
      { line: 2, raw: 'https://www.douyin.com/user/SEC_D', ok: false, reason: '缺少作者名称' }
    ])
  })

  it('无法识别的链接（非抖音域名/非法字符）→ reason=未识别到抖音主页链接', async () => {
    const { importAuthors } = setup()
    const r = await importAuthors([{ nickname: '作者E', url: 'https://www.baidu.com/user/xxx' }])
    expect(r.created).toBe(0)
    expect(r.results).toEqual([{ line: 1, raw: 'https://www.baidu.com/user/xxx', ok: false, reason: '未识别到抖音主页链接' }])
  })

  it('短链接（v.douyin.com）→ 与「其它无法解析」区分开，reason=暂不支持短链接，请粘贴完整主页链接', async () => {
    const { importAuthors } = setup()
    const r = await importAuthors([{ nickname: '作者F', url: 'https://v.douyin.com/iXXXXXXX/' }])
    expect(r.created).toBe(0)
    expect(r.results).toEqual([{ line: 1, raw: 'https://v.douyin.com/iXXXXXXX/', ok: false, reason: '暂不支持短链接，请粘贴完整主页链接' }])
  })

  it('本次粘贴中重复：同一次调用内 sec_uid 重复（URL 与裸 sec_uid 混用也算重复）→ 第二次起标记', async () => {
    const { importAuthors } = setup()
    const r = await importAuthors([
      { nickname: '作者G', url: 'https://www.douyin.com/user/SEC_G' },
      { nickname: '作者G2', url: 'SEC_G' }
    ])
    expect(r.created).toBe(1)
    expect(r.results).toEqual([
      { line: 1, raw: 'https://www.douyin.com/user/SEC_G', ok: true },
      { line: 2, raw: 'SEC_G', ok: false, reason: '本次粘贴中重复' }
    ])
  })

  it('已存在，未修改：库里已有该作者 → 不新建、不刷新 nickname，reason=已存在，未修改', async () => {
    const { db, importAuthors } = setup()
    await importAuthors([{ nickname: '原名', url: 'https://www.douyin.com/user/SEC_H' }])
    const r = await importAuthors([{ nickname: '新名字', url: 'https://www.douyin.com/user/SEC_H' }])
    expect(r.created).toBe(0)
    expect(r.results).toEqual([{ line: 1, raw: 'https://www.douyin.com/user/SEC_H', ok: false, reason: '已存在，未修改' }])
    const authors = listAuthors(db)
    expect(authors).toHaveLength(1)
    expect(authors[0].nickname).toBe('原名') // 未被第二次导入覆盖
  })

  it('混合场景：多行各命中不同分支，created 计数与逐行结果都正确', async () => {
    const { importAuthors } = setup()
    const r = await importAuthors([
      { nickname: '有效1', url: 'https://www.douyin.com/user/SEC_M1' },
      { nickname: '', url: 'https://www.douyin.com/user/SEC_M2' },
      { nickname: '短链', url: 'https://v.douyin.com/iYYYYYYY/' },
      { nickname: '重复', url: 'SEC_M1' },
      { nickname: '无法识别', url: 'not a valid url!!' }
    ])
    expect(r.created).toBe(1)
    expect(r.results.map(x => x.ok)).toEqual([true, false, false, false, false])
    expect(r.results[1].reason).toBe('缺少作者名称')
    expect(r.results[2].reason).toBe('暂不支持短链接，请粘贴完整主页链接')
    expect(r.results[3].reason).toBe('本次粘贴中重复')
    expect(r.results[4].reason).toBe('未识别到抖音主页链接')
  })
})

// D 阶段：批量导入以前把平台写死成 douyin，粘快手链接会得到「未识别到抖音主页链接」，
// 用户完全看不出问题在哪。现在平台由调用方给出，落库也用这个平台。
describe('authors:import 按平台解析', () => {
  function importWith(platform: string) {
    const { db } = setup()
    const handler = mockIpc.handlers.get('authors:import')!
    return {
      db,
      run: (items: ImportItem[]) => handler(null, items, platform) as Promise<ImportResult>
    }
  }

  it('快手：完整主页链接被接受，并按 kuaishou 落库', async () => {
    const { db, run } = importWith('kuaishou')
    const r = await run([{ nickname: '快手作者', url: 'https://www.kuaishou.com/profile/3xAUTHOR1' }])

    expect(r.created).toBe(1)
    expect(r.results[0]).toMatchObject({ line: 1, ok: true })
    const row = db.prepare('SELECT platform, sec_uid, home_url FROM authors').get() as
      { platform: string; sec_uid: string; home_url: string }
    expect(row).toEqual({
      platform: 'kuaishou',
      sec_uid: '3xAUTHOR1',
      home_url: 'https://www.kuaishou.com/profile/3xAUTHOR1'
    })
  })

  it('快手模式下粘抖音链接 → 提示说的是快手，不再张冠李戴', async () => {
    const { run } = importWith('kuaishou')
    const r = await run([{ nickname: '走错门的', url: 'https://www.douyin.com/user/SEC_X' }])
    expect(r.results[0]).toMatchObject({ ok: false, reason: '未识别到快手主页链接' })
  })

  it('快手短链接与「压根不是本平台链接」区分开', async () => {
    const { run } = importWith('kuaishou')
    const r = await run([{ nickname: '短链', url: 'https://v.kuaishou.com/ABC123' }])
    expect(r.results[0]).toMatchObject({ ok: false, reason: '暂不支持短链接，请粘贴完整主页链接' })
  })

  it('未注册平台 → 每行都明确失败，不静默当成抖音处理', async () => {
    const { db, run } = importWith('weibo')
    const r = await run([{ nickname: '某人', url: 'https://weibo.com/u/123' }])
    expect(r.created).toBe(0)
    expect(r.results[0]).toMatchObject({ ok: false, reason: '不支持的平台：weibo' })
    expect(db.prepare('SELECT COUNT(*) c FROM authors').get()).toEqual({ c: 0 })
  })

  it('不传平台时沿用抖音（老调用方不受影响）', async () => {
    const { db } = setup()
    const handler = mockIpc.handlers.get('authors:import')!
    const r = await handler(null, [{ nickname: '老用法', url: 'https://www.douyin.com/user/SEC_OLD' }]) as ImportResult
    expect(r.created).toBe(1)
    expect((db.prepare('SELECT platform FROM authors').get() as { platform: string }).platform).toBe('douyin')
  })
})
