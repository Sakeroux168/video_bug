import { describe, expect, it, vi, beforeEach } from 'vitest'
import { VideoBrowser } from '../src/main/browser'
import { xiaohongshuAdapter } from '../src/main/adapters/xiaohongshu'
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
