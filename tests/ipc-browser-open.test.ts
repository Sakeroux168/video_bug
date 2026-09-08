import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from '../src/main/db'
import { getAdapter } from '../src/main/adapters'

// 员工反馈：内置浏览器页只能打开抖音窗口，打不开快手的。
// 后果不只是"看不到"——快手要扫码登录，而登录只能在那个窗口里做。
// 此前只有 browser:show（显示"当前那个窗口"），没有任何切平台的入口。

const mockIpc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { handlers, userData: process.cwd() + '/.tmp-ipc-browser-open' }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (...args: unknown[]) => unknown): void => { mockIpc.handlers.set(c, fn) },
    on: () => {},
    removeHandler: () => {}
  },
  app: { getPath: () => mockIpc.userData, getAppPath: () => '' },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc'

type OpenResult = { ok: boolean; error?: string }

function setup(isRunning = false) {
  const db = new DatabaseSync(':memory:')
  initDb(db)
  mockIpc.handlers.clear()
  const loaded: Array<{ platform: string; url: string }> = []
  const visible: boolean[] = []
  registerIpc({
    db,
    scheduler: { get isRunning() { return isRunning }, get currentTaskId() { return 0 } } as never,
    downloader: {} as never,
    analyzer: null,
    browser: {
      load: vi.fn(async (adapter: { name: string }, url: string) => { loaded.push({ platform: adapter.name, url }) })
    } as never,
    getWindow: () => ({}) as never,
    reloadAnalyzer: () => {},
    reloadOrganizer: () => {},
    getOrganizer: () => null,
    enqueueTask: () => {},
    dequeueTask: () => {},
    setBrowserVisible: (v: boolean) => { visible.push(v) }
  } as never)
  const open = mockIpc.handlers.get('browser:open')!
  return { loaded, visible, open: (p: string) => open(null, p) as Promise<OpenResult> }
}

beforeEach(() => { mockIpc.handlers.clear() })

describe('browser:open 按平台打开内置浏览器', () => {
  it('打开快手 → 用快手适配器加载快手首页，并把窗口显示出来', async () => {
    const { loaded, visible, open } = setup()

    await expect(open('kuaishou')).resolves.toEqual({ ok: true })
    expect(loaded).toEqual([{ platform: 'kuaishou', url: getAdapter('kuaishou')!.homeUrl }])
    expect(visible).toEqual([true])
  })

  it('打开抖音同理，两个平台都能主动打开（登录只能在各自窗口里做）', async () => {
    const { loaded, open } = setup()
    await open('douyin')
    expect(loaded[0]).toEqual({ platform: 'douyin', url: getAdapter('douyin')!.homeUrl })
  })

  it('未注册平台 → 明确拒绝，不去加载一个不存在的首页', async () => {
    const { loaded, open } = setup()
    await expect(open('weibo')).resolves.toMatchObject({ ok: false })
    expect(loaded).toEqual([])
  })

  it('有任务正在跑 → 拒绝切换，否则会把调度器正在用的窗口销毁重建', async () => {
    const { loaded, visible, open } = setup(true)

    const r = await open('kuaishou')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/任务/)
    expect(loaded).toEqual([]) // 窗口一动没动
    expect(visible).toEqual([])
  })
})

describe('平台适配器都要有首页地址', () => {
  it('抖音与快手各自的首页', () => {
    expect(getAdapter('douyin')!.homeUrl).toBe('https://www.douyin.com/')
    expect(getAdapter('kuaishou')!.homeUrl).toBe('https://www.kuaishou.com/')
  })

  it('首页主机必须在该平台的作品白名单里，避免打开到别处', () => {
    for (const name of ['douyin', 'kuaishou']) {
      const a = getAdapter(name)!
      expect(a.sourceHosts).toContain(new URL(a.homeUrl).hostname)
    }
  })
})
