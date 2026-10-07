import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'

// preload 是页面世界与主进程之间唯一的原始响应通道。B 阶段把它从抖音专用
// （dy:raw / src/preload/douyin.ts）改成平台无关（platform:raw / src/preload/platform.ts），
// 快手、后续小红书共用同一份。这里锁死频道名和转发条件——写错一个字，
// 真机表现是「浏览器在滚、界面一条也抓不到」，且没有任何报错。

const ipc = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    send: ipc.send,
    on: (channel: string, fn: (...args: unknown[]) => void) => { ipc.handlers.set(channel, fn); ipc.on(channel, fn) }
  }
}))

/** 每个用例一份干净的 jsdom window + 重新加载 preload（模块顶层会注册监听） */
async function loadPreload(): Promise<{ window: any }> {
  const dom = new JSDOM('<!doctype html>', { url: 'https://www.kuaishou.com/' })
  const window = dom.window as any
  ;(globalThis as any).window = window
  vi.resetModules()
  ipc.handlers.clear()
  await import('../src/preload/platform')
  return { window }
}

/** 页面自己发消息。真浏览器里 window.postMessage 收到的事件 source 是本窗口、origin 是本页面；
 *  jsdom 不填这两项（都是空），所以这里按真浏览器的样子派发（2026-10-07 preload 开始校验来源后需要） */
function pagePost(window: any, data: unknown): void {
  window.dispatchEvent(new window.MessageEvent('message', { data, source: window, origin: window.location.origin }))
}

/** 页面世界 postMessage 会异步派发，等一拍 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  ipc.send.mockClear()
  ipc.on.mockClear()
})

describe('preload 原始响应通道（平台无关）', () => {
  it('页面发 platform:raw → 原样转发到主进程的 platform:raw 频道', async () => {
    const { window } = await loadPreload()
    const url = 'https://www.kuaishou.com/graphql'
    const data = { data: { visionSearchPhoto: { feeds: [] } } }

    pagePost(window, { type: 'platform:raw', url, data })
    await flush()

    expect(ipc.send).toHaveBeenCalledWith('platform:raw', { url, json: data })
  })

  it('缺 url 时补空串，不把 undefined 送进主进程', async () => {
    const { window } = await loadPreload()
    pagePost(window, { type: 'platform:raw', data: { a: 1 } })
    await flush()
    expect(ipc.send).toHaveBeenCalledWith('platform:raw', { url: '', json: { a: 1 } })
  })

  it('滚动中止信号不能被当成原始响应回传（旧实现按前缀匹配会把它回传成一条空 raw）', async () => {
    const { window } = await loadPreload()
    const handler = ipc.handlers.get('platform:scroll-abort')
    expect(handler).toBeTypeOf('function')

    const seen: unknown[] = []
    window.addEventListener('message', (e: MessageEvent) => seen.push(e.data))
    handler!()
    await flush()

    // 页面世界确实收到了中止信号
    expect(seen).toEqual([{ type: 'platform:scroll-abort' }])
    // 但它不该被回传成 platform:raw
    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('无关页面消息一律不转发', async () => {
    const { window } = await loadPreload()
    for (const payload of [null, 'text', 42, {}, { type: 'other:raw', url: 'u' }, { type: 123 }]) {
      pagePost(window, payload)
    }
    await flush()
    expect(ipc.send).not.toHaveBeenCalled()
  })
})

// 2026-10-07 安全加固 A8（全面检查 安全 M5 / 隐患 13）：只认页面自己发的消息。
// 以前页面里嵌的第三方框（广告等）parent.postMessage 一条 platform:raw，就能往库里塞假视频、假下载地址。
describe('preload 只认页面自己发的 platform:raw', () => {
  it('别的框发来的（source 不是本页面）→ 不转发', async () => {
    const { window } = await loadPreload()
    const other = new JSDOM('<!doctype html>', { url: 'https://ads.example.com/' }).window
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'platform:raw', url: 'https://www.kuaishou.com/graphql', data: { fake: 1 } },
      source: other, origin: 'https://ads.example.com'
    }))
    await flush()
    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('来源是本页面、但 origin 对不上 → 不转发', async () => {
    const { window } = await loadPreload()
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'platform:raw', url: 'x', data: {} }, source: window, origin: 'https://ads.example.com'
    }))
    await flush()
    expect(ipc.send).not.toHaveBeenCalled()
  })
})
