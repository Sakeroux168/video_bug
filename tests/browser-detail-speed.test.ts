import { describe, expect, it, vi, beforeEach } from 'vitest'
import { VideoBrowser } from '../src/main/browser'
import { xiaohongshuAdapter } from '../src/main/adapters/xiaohongshu'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'
import type { PlatformAdapter } from '../src/main/adapters/types'

// 稳妥模式提速：详情注水状态改用 webContents.mainFrame.executeJavaScript 读取
// （WebFrameMain 的执行不等页面停止加载），每次调用重新取 mainFrame。

const sessionFromPartition = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {},
  session: { fromPartition: sessionFromPartition }
}))

function pageDetailJson(noteId: string): unknown {
  return { data: { items: [{ id: noteId, note_card: {
    noteId, type: 'video', title: noteId, time: 1780000000000,
    user: { user_id: 'AUTHOR', nickname: '作者' },
    video: { capa: { duration: 8 }, media: { stream: { EF4: [
      { width: 720, height: 1280, master_url: 'https://cdn.test/video.mp4' }
    ] } } }
  } }] } }
}

describe('VideoBrowser.extractCurrentDetail 用 mainFrame', () => {
  it('通过 webContents.mainFrame.executeJavaScript 读取，拿到当前笔记详情', async () => {
    const b = new VideoBrowser({} as never)
    const mainExec = vi.fn(async () => pageDetailJson('N1'))
    ;(b as unknown as { win: unknown }).win = {
      isDestroyed: () => false,
      webContents: { mainFrame: { executeJavaScript: mainExec } }
    }
    const item = await b.extractCurrentDetail(xiaohongshuAdapter, 'N1')
    expect(item?.awemeId).toBe('N1')
    expect(item?.playUrl).toBe('https://cdn.test/video.mp4')
    expect(mainExec).toHaveBeenCalledTimes(1)
  })

  it('每次调用重新取 mainFrame（跨域导航后 frame 会变）', async () => {
    const b = new VideoBrowser({} as never)
    const frames = [
      { executeJavaScript: vi.fn(async () => pageDetailJson('N1')) },
      { executeJavaScript: vi.fn(async () => null) }
    ]
    let call = 0
    ;(b as unknown as { win: unknown }).win = {
      isDestroyed: () => false,
      get webContents(): unknown {
        return { get mainFrame(): unknown { return frames[Math.min(call++, frames.length - 1)] } }
      }
    }
    await b.extractCurrentDetail(xiaohongshuAdapter, 'N1')
    await b.extractCurrentDetail(xiaohongshuAdapter, 'N1')
    expect(frames[0].executeJavaScript).toHaveBeenCalledTimes(1)
    expect(frames[1].executeJavaScript).toHaveBeenCalledTimes(1)
  })
})

// 2026-10-07 升级 Electron 44 真机发现：页面一跳转，跳转前发出的 executeJavaScript 永远不返回（旧版会报错返回）。
// 调度器每 200ms 读一次，读到一半卡住就再也不读了 → 每条笔记都「详情超时，跳过」。读详情必须有超时。
describe('VideoBrowser.extractCurrentDetail 不会卡死', () => {
  it('这一次读取一直不返回 → 到时间返回 null，下一次照常读', async () => {
    vi.useFakeTimers()
    try {
      const b = new VideoBrowser({} as never)
      const frames = [
        { executeJavaScript: vi.fn(() => new Promise(() => {})) },
        { executeJavaScript: vi.fn(async () => pageDetailJson('N1')) }
      ]
      let call = 0
      ;(b as unknown as { win: unknown }).win = {
        isDestroyed: () => false,
        get webContents(): unknown { return { get mainFrame(): unknown { return frames[Math.min(call++, 1)] } } }
      }
      const first = b.extractCurrentDetail(xiaohongshuAdapter, 'N1')
      await vi.advanceTimersByTimeAsync(5000)
      expect(await first).toBeNull()
      expect((await b.extractCurrentDetail(xiaohongshuAdapter, 'N1'))?.awemeId).toBe('N1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('VideoBrowser.fetchDetailHtml（快速模式 session fetch）', () => {
  beforeEach(() => { sessionFromPartition.mockReset() })

  it('用平台分区 session 拉取详情 HTML，返回最终地址与响应体', async () => {
    const b = new VideoBrowser({} as never)
    const stubSession = {
      fetch: vi.fn(async () => ({ status: 200, url: 'https://www.xiaohongshu.com/explore/N1?x', text: async () => '<html>state</html>' }))
    }
    sessionFromPartition.mockImplementation((name: string) => {
      expect(name).toBe('persist:xiaohongshu')
      return stubSession
    })
    const r = await b.fetchDetailHtml(xiaohongshuAdapter as PlatformAdapter, 'https://www.xiaohongshu.com/explore/N1?xsec_token=PRIVATE_TOKEN')
    expect(r).toEqual({ status: 200, finalUrl: 'https://www.xiaohongshu.com/explore/N1?x', body: '<html>state</html>' })
    expect(stubSession.fetch).toHaveBeenCalledTimes(1)
  })

  it('请求失败返回 null，不抛出', async () => {
    const b = new VideoBrowser({} as never)
    sessionFromPartition.mockImplementation(() => { throw new Error('no session') })
    const r = await b.fetchDetailHtml(xiaohongshuAdapter as PlatformAdapter, 'https://www.xiaohongshu.com/explore/N1')
    expect(r).toBeNull()
  })
})

// 2026-10-07 性能 F7：平台窗口以前一直关着后台节流——没任务时藏起来的抖音首页推荐流也在全速跑
// （定时器、动画、自动播放、轮询）。现在只有任务在跑时才关节流，没任务时交给 Chromium 正常节流。
describe('VideoBrowser.setBusy：只在任务进行中关掉后台节流', () => {
  it('开始任务 → 关节流；任务结束 → 恢复节流', () => {
    const b = new VideoBrowser({} as never)
    const setBackgroundThrottling = vi.fn()
    ;(b as unknown as { win: unknown }).win = { isDestroyed: () => false, webContents: { setBackgroundThrottling } }
    b.setBusy(true)
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(false)
    b.setBusy(false)
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })

  it('窗口还没建 → 不报错，记住状态', () => {
    const b = new VideoBrowser({} as never)
    expect(() => b.setBusy(true)).not.toThrow()
    expect(b.isBusy).toBe(true)
  })
})

// 2026-10-07 用户：快手页打不开。查下来是系统代理（翻墙软件）——内置浏览器跟着系统代理走，
// 快手拒绝从代理过来的请求（首页只回一行 {"result":2}），关掉代理直连就正常。
// 现在平台网页默认直连，不走系统代理；设置里可以关掉这个开关恢复走系统代理。
describe('VideoBrowser.setDirect：平台网页直连，不走系统代理', () => {
  beforeEach(() => { sessionFromPartition.mockReset() })

  it('开（默认）→ 平台分区设成直连；关 → 恢复系统代理', async () => {
    const setProxy = vi.fn(async () => {})
    sessionFromPartition.mockReturnValue({ setProxy })
    const b = new VideoBrowser({} as never)
    ;(b as unknown as { current: unknown }).current = xiaohongshuAdapter
    await b.setDirect(true)
    expect(sessionFromPartition).toHaveBeenLastCalledWith('persist:xiaohongshu')
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    await b.setDirect(false)
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
  })

  it('还没打开平台窗口 → 先记住，打开时再设', async () => {
    const setProxy = vi.fn(async () => {})
    sessionFromPartition.mockReturnValue({ setProxy })
    const b = new VideoBrowser({} as never)
    await b.setDirect(true)
    expect(setProxy).not.toHaveBeenCalled()
    expect(b.isDirect).toBe(true)
  })
})

// 2026-10-07 再查：快手还会拒绝浏览器标识里带「video-scraper/x.y.z」或「Electron/x.y.z」的请求
// （同样只回 {"result":2}；用户换了台电脑也一样）。平台窗口改用同版本普通 Chrome 的标识。
describe('快手窗口的浏览器标识是普通 Chrome 的（别的平台不动）', () => {
  it('小红书不改标识（它的登录跟标识绑着，改了要重新登录）', async () => {
    const setUserAgent = vi.fn()
    sessionFromPartition.mockReturnValue({ setProxy: vi.fn(async () => {}), getUserAgent: () => 'X Electron/44.6.0 Y', setUserAgent })
    const b = new VideoBrowser({} as never)
    ;(b as unknown as { current: unknown }).current = xiaohongshuAdapter
    await b.setDirect(true)
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  beforeEach(() => { sessionFromPartition.mockReset() })

  it('去掉 video-scraper/版本号 和 Electron/版本号，其余照旧', async () => {
    const setUserAgent = vi.fn()
    sessionFromPartition.mockReturnValue({
      setProxy: vi.fn(async () => {}),
      getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) video-scraper/0.1.3 Chrome/152.0.7977.130 Electron/44.6.0 Safari/537.36',
      setUserAgent
    })
    const b = new VideoBrowser({} as never)
    ;(b as unknown as { current: unknown }).current = kuaishouAdapter
    await b.setDirect(true)
    expect(setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36')
  })
})

// 2026-10-09：快手第一次打开有时只回一行 {"result":2,...}（页面空白），刷新一次就好了（真机：同一个窗口 reload 后正常）。
// 用户看到的「快手又看不了了」就是这个。快手页面打开后如果是这一行，自动再打开，最多 2 次。
describe('快手第一次打开被拒 → 自动再打开', () => {
  function fakeWin(bodies: string[]) {
    let i = 0
    const loadURL = vi.fn(async () => {})
    const win = {
      isDestroyed: () => false,
      loadURL,
      webContents: { mainFrame: { executeJavaScript: vi.fn(async () => bodies[Math.min(i++, bodies.length - 1)]) } }
    }
    return { win, loadURL }
  }
  function browserWith(win: unknown) {
    const b = new VideoBrowser({} as never)
    const anyB = b as unknown as { win: unknown; current: unknown; ensureWindow: () => Promise<void>; blockedRetryDelayMs: number }
    anyB.win = win
    anyB.current = kuaishouAdapter
    anyB.ensureWindow = async () => {}
    anyB.blockedRetryDelayMs = 0
    return b
  }
  const BLOCKED = '{"result":2,"error_msg":null,"request_id":"1"}'

  it('第一次是那一行 → 再打开一次，第二次正常就停', async () => {
    const { win, loadURL } = fakeWin([BLOCKED, '搜索 上传作品 推荐 发现'])
    await browserWith(win).load(kuaishouAdapter, 'https://www.kuaishou.com/')
    expect(loadURL).toHaveBeenCalledTimes(2)
  })

  it('一直是那一行 → 最多再试 2 次就不试了（不无限刷）', async () => {
    const { win, loadURL } = fakeWin([BLOCKED])
    await browserWith(win).load(kuaishouAdapter, 'https://www.kuaishou.com/')
    expect(loadURL).toHaveBeenCalledTimes(3)
  })

  it('第一次就正常 → 只打开一次；别的平台不管这个', async () => {
    const ok = fakeWin(['推荐 发现'])
    await browserWith(ok.win).load(kuaishouAdapter, 'https://www.kuaishou.com/')
    expect(ok.loadURL).toHaveBeenCalledTimes(1)
    const dy = fakeWin([BLOCKED])
    const b = browserWith(dy.win)
    ;(b as unknown as { current: unknown }).current = xiaohongshuAdapter
    await b.load(xiaohongshuAdapter, 'https://www.xiaohongshu.com/')
    expect(dy.loadURL).toHaveBeenCalledTimes(1)
  })
})
