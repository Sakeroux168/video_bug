import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildInjectScript } from '../src/main/injector'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'

// 既有 7 个用例原样保留，只把写死的抖音特征换成适配器声明的那一份——
// 覆盖强度不变（fetch / XHR text / XHR json / 幂等守卫 / 真实事件链一个不少）
const INJECT_SCRIPT = buildInjectScript(douyinAdapter.rawUrlHints)

// P0 补测（决策审查 2026-08-05 缺口 5）：
// INJECT_SCRIPT 是注入到抖音页面的纯字符串钩子脚本，真实浏览器里拦截 fetch/XHR 后
// postMessage 发 { type: 'platform:raw', url, data } 给主窗口供拦截日志使用。
// 消息名平台无关：抖音、快手、后续小红书共用同一条原始响应通道。
// 用 jsdom 的 outside-only 模式提供 window.eval 在真实 window 上下文求值脚本字符串，
// 以可控 stub 驱动 fetch/XHR 两条拦截路径并断言消息载荷；原人工验收项 d（拦截日志有数据）由此替代。
// 注意：本文件在 node 环境运行（不在 tests/components/ 下），jsdom 实例独立，不依赖全局 window。

type AnyWindow = any

/** 新建 jsdom 页面；postMessage stub 成 vi.fn 以便同步断言消息载荷 */
function createPage(): { window: AnyWindow; post: ReturnType<typeof vi.fn> } {
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' })
  const window = dom.window as AnyWindow
  const post = vi.fn()
  window.postMessage = post
  // 默认给一个无害的 fetch stub：脚本安装时无条件执行 window.fetch.bind(window)，
  // 真实页面必有 fetch 而 jsdom 默认没有——统一提供，避免脚本在纯 XHR 用例里安装即崩
  window.fetch = vi.fn(() => Promise.resolve(jsonResponse('https://x.com/empty', {}, 'text/plain')))
  return { window, post }
}

/** 构造 fetch Response 形状（脚本只用到 url / headers.get / clone().text()） */
function jsonResponse(url: string, body: unknown, contentType = 'application/json'): unknown {
  const text = JSON.stringify(body)
  return {
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    clone: () => ({ text: () => Promise.resolve(text) })
  }
}

/** 用可手动触发 load 的假 XHR 替换 window.XMLHttpRequest（open/send 记参由测试驱动） */
function installFakeXhr(window: AnyWindow): void {
  class FakeXHR extends window.EventTarget {
    method = ''
    responseType = ''
    response: unknown = null
    responseText = ''
    contentType = ''
  }
  // 必须挂在 prototype 上：脚本读取并包装 XMLHttpRequest.prototype.open/send
  const proto = FakeXHR.prototype
  proto.open = vi.fn(function (this: FakeXHR, method: string) { this.method = method })
  proto.send = vi.fn(function () {})
  proto.getResponseHeader = vi.fn(function (this: FakeXHR, name: string) {
    return name.toLowerCase() === 'content-type' ? this.contentType : null
  })
  window.XMLHttpRequest = FakeXHR
}

/** 等微任务/任务队列排空（脚本在 .then 链里异步 postMessage） */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('页面钩子脚本 INJECT_SCRIPT（jsdom 求值）', () => {
  it('fetch 拦截：json 响应 → postMessage 发出 platform:raw（url + 解析后 data）', async () => {
    const { window, post } = createPage()
    const url = 'https://www.douyin.com/aweme/v1/web/general/search/'
    const body = { status_code: 0, aweme_list: [{ aweme_id: '1' }] }
    const fetchStub = vi.fn(() => Promise.resolve(jsonResponse(url, body)))
    window.fetch = fetchStub

    window.eval(INJECT_SCRIPT)

    await window.fetch(url)
    await flush()
    // 原始 fetch 被调用；包装层解析 json 后发出拦截消息
    expect(fetchStub).toHaveBeenCalledWith(url)
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: body }, '*')
  })

  it('fetch 拦截：非 json content-type → 只透传不发送消息', async () => {
    const { window, post } = createPage()
    window.fetch = vi.fn(() => Promise.resolve(jsonResponse('https://x.com/other', { a: 1 }, 'text/html')))
    window.eval(INJECT_SCRIPT)

    await window.fetch('https://x.com/other')
    await flush()
    expect(post).not.toHaveBeenCalled()
  })

  it('XHR 拦截：responseType=json → 读 response 发送 platform:raw', () => {
    const { window, post } = createPage()
    installFakeXhr(window)
    window.eval(INJECT_SCRIPT)

    const url = 'https://www.douyin.com/aweme/v1/web/general/search/'
    const xhr = new window.XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'json'
    xhr.response = { data: { list: ['a'] } }
    xhr.contentType = 'application/json'
    xhr.send()
    xhr.dispatchEvent(new window.Event('load'))

    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: { data: { list: ['a'] } } }, '*')
  })

  it('XHR 拦截：content-type 非 json 但 URL 含抖音接口路径（text 分支）也解析', () => {
    const { window, post } = createPage()
    installFakeXhr(window)
    window.eval(INJECT_SCRIPT)

    const url = 'https://www.douyin.com/aweme/v1/web/general/search/'
    const xhr = new window.XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'text'
    xhr.responseText = JSON.stringify({ ok: 1 })
    xhr.contentType = 'text/html'
    xhr.send()
    xhr.dispatchEvent(new window.Event('load'))

    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: { ok: 1 } }, '*')
  })

  it('XHR 拦截：非 json 且 URL 无抖音特征 → 不发送消息', () => {
    const { window, post } = createPage()
    installFakeXhr(window)
    window.eval(INJECT_SCRIPT)

    const xhr = new window.XMLHttpRequest()
    xhr.open('GET', 'https://other.com/api/items')
    xhr.responseType = 'text'
    xhr.responseText = JSON.stringify({ a: 1 })
    xhr.contentType = 'text/plain'
    xhr.send()
    xhr.dispatchEvent(new window.Event('load'))

    expect(post).not.toHaveBeenCalled()
  })

  it('__platformHookInstalled 幂等守卫：重复执行只包装一次', () => {
    const { window } = createPage()
    const fetchStub = vi.fn(() => Promise.resolve(jsonResponse('https://x.com/a', { a: 1 })))
    window.fetch = fetchStub
    installFakeXhr(window)
    const origOpen = window.XMLHttpRequest.prototype.open

    window.eval(INJECT_SCRIPT)
    const wrappedFetch = window.fetch
    const wrappedOpen = window.XMLHttpRequest.prototype.open
    expect(window.__platformHookInstalled).toBe(true)
    expect(wrappedFetch).not.toBe(fetchStub)
    expect(wrappedOpen).not.toBe(origOpen)

    // 二次执行直接 return：fetch/XHR 引用不变（未被再次包装）
    window.eval(INJECT_SCRIPT)
    expect(window.__platformHookInstalled).toBe(true)
    expect(window.fetch).toBe(wrappedFetch)
    expect(window.XMLHttpRequest.prototype.open).toBe(wrappedOpen)
  })

  it('真实 postMessage 事件链：拦截消息经 message 事件送达（window 监听收）', async () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' })
    const window = dom.window as AnyWindow
    const received: unknown[] = []
    window.addEventListener('message', (e: MessageEvent) => received.push(e.data))

    const url = 'https://www.douyin.com/aweme/v1/hot/search/'
    window.fetch = vi.fn(() => Promise.resolve(jsonResponse(url, { hot: ['a'] })))
    window.eval(INJECT_SCRIPT)

    await window.fetch(url)
    // 固定等 10ms 在并行跑多个 jsdom 文件时偶发不够（拦截消息经 .then 链 + 事件派发异步送达）。
    // 改成轮询到达即止，断言本身一字未改。
    for (let i = 0; i < 100 && received.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(received).toEqual([{ type: 'platform:raw', url, data: { hot: ['a'] } }])
  })
})

// ---------------------------------------------------------------------------
// URL 兜底特征改由适配器声明：注入脚本本身不认识任何平台。
// 快手的 /graphql 响应若 content-type 不标准，只有在用快手特征构建脚本时才会被解析。
// ---------------------------------------------------------------------------
describe('buildInjectScript 的 URL 兜底特征由平台提供', () => {
  /** 驱动一次 content-type 非 json 的 XHR text 分支 */
  function xhrTextRound(script: string, url: string): ReturnType<typeof vi.fn> {
    const { window, post } = createPage()
    installFakeXhr(window)
    window.eval(script)
    const xhr = new window.XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'text'
    xhr.responseText = JSON.stringify({ ok: 1 })
    xhr.contentType = 'text/html'
    xhr.send()
    xhr.dispatchEvent(new window.Event('load'))
    return post
  }

  const KS_GRAPHQL = 'https://www.kuaishou.com/graphql'
  const DY_SEARCH = 'https://www.douyin.com/aweme/v1/web/general/search/'

  it('用快手特征构建 → /graphql 的非标准 content-type 响应被解析', () => {
    const post = xhrTextRound(buildInjectScript(kuaishouAdapter.rawUrlHints), KS_GRAPHQL)
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url: KS_GRAPHQL, data: { ok: 1 } }, '*')
  })

  it('用抖音特征构建 → 同一条 /graphql 响应不被解析（证明兜底真由特征驱动，不是脚本里写死）', () => {
    const post = xhrTextRound(buildInjectScript(douyinAdapter.rawUrlHints), KS_GRAPHQL)
    expect(post).not.toHaveBeenCalled()
  })

  it('用快手特征构建 → 抖音搜索接口不被兜底解析（互不串台）', () => {
    const post = xhrTextRound(buildInjectScript(kuaishouAdapter.rawUrlHints), DY_SEARCH)
    expect(post).not.toHaveBeenCalled()
  })

  it('空特征 → 只认标准 json content-type，兜底分支全关', () => {
    const post = xhrTextRound(buildInjectScript([]), DY_SEARCH)
    expect(post).not.toHaveBeenCalled()
  })

  it('抖音特征就是搬迁前脚本里写死的那两条，不许悄悄收窄', () => {
    expect(douyinAdapter.rawUrlHints).toEqual(['/aweme/', '/search/'])
    // 真机实测搜索走 /rest/v/search/feed，兜底特征跟着加宽；抖音那两条一字未动
    expect(kuaishouAdapter.rawUrlHints).toEqual(['/graphql', '/rest/v/'])
  })

  it('脚本不含任何平台专有字面量（泛化后不该再出现 dy: 前缀）', () => {
    const script = buildInjectScript(douyinAdapter.rawUrlHints)
    expect(script).not.toMatch(/dy:raw|__dyHookInstalled|__dyUrl/)
    expect(script).toContain('platform:raw')
  })
})

// 2026-10-07 性能 F11：页面钩子先按适配器的接口地址过滤——埋点、评论、推荐这些无关的 JSON
// 以前都要在页面里解析一遍、再序列化两次（postMessage + IPC）送到主进程，然后被丢掉。
// 现在无关的只报一个地址（拦截日志里还能看到「忽略」），不读内容、不解析。
describe('页面钩子按接口地址过滤', () => {
  const SCRIPT = buildInjectScript(douyinAdapter.rawUrlHints, douyinAdapter.apiUrlPatterns)

  it('fetch：接口地址对得上 → 解析后发出', async () => {
    const { window, post } = createPage()
    const url = 'https://www.douyin.com/aweme/v1/web/general/search/'
    window.fetch = vi.fn(() => Promise.resolve(jsonResponse(url, { a: 1 })))
    window.eval(SCRIPT)
    await window.fetch(url)
    await flush()
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: { a: 1 } }, '*')
  })

  it('fetch：无关的 JSON → 只报地址，不读内容', async () => {
    const { window, post } = createPage()
    const url = 'https://mcs.zijieapi.com/list'
    const text = vi.fn(() => Promise.resolve('{"x":1}'))
    window.fetch = vi.fn(() => Promise.resolve({
      url, headers: { get: () => 'application/json' }, clone: () => ({ text })
    }))
    window.eval(SCRIPT)
    await window.fetch(url)
    await flush()
    expect(text).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: null }, '*')
  })

  it('XHR：无关的 JSON → 只报地址，不解析', async () => {
    const { window, post } = createPage()
    installFakeXhr(window)
    window.eval(SCRIPT)
    const xhr = new window.XMLHttpRequest()
    xhr.open('GET', '//mon.zijieapi.com/monitor_browser/collect')
    xhr.contentType = 'application/json'
    xhr.responseText = '{"big":"payload"}'
    xhr.send()
    xhr.dispatchEvent(new window.Event('load'))
    await flush()
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url: '//mon.zijieapi.com/monitor_browser/collect', data: null }, '*')
  })

  it('快手的正则带 i 标记也照样认', async () => {
    const { window, post } = createPage()
    const s = buildInjectScript(kuaishouAdapter.rawUrlHints, kuaishouAdapter.apiUrlPatterns)
    const url = 'https://www.kuaishou.com/GRAPHQL'
    window.fetch = vi.fn(() => Promise.resolve(jsonResponse(url, { d: 1 })))
    window.eval(s)
    await window.fetch(url)
    await flush()
    expect(post).toHaveBeenCalledWith({ type: 'platform:raw', url, data: { d: 1 } }, '*')
  })
})
