import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { INJECT_SCRIPT } from '../src/main/injector'

// P0 补测（决策审查 2026-08-05 缺口 5）：
// INJECT_SCRIPT 是注入到抖音页面的纯字符串钩子脚本，真实浏览器里拦截 fetch/XHR 后
// postMessage 发 { type: 'dy:raw', url, data } 给主窗口供拦截日志使用。
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
  it('fetch 拦截：json 响应 → postMessage 发出 dy:raw（url + 解析后 data）', async () => {
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
    expect(post).toHaveBeenCalledWith({ type: 'dy:raw', url, data: body }, '*')
  })

  it('fetch 拦截：非 json content-type → 只透传不发送消息', async () => {
    const { window, post } = createPage()
    window.fetch = vi.fn(() => Promise.resolve(jsonResponse('https://x.com/other', { a: 1 }, 'text/html')))
    window.eval(INJECT_SCRIPT)

    await window.fetch('https://x.com/other')
    await flush()
    expect(post).not.toHaveBeenCalled()
  })

  it('XHR 拦截：responseType=json → 读 response 发送 dy:raw', () => {
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

    expect(post).toHaveBeenCalledWith({ type: 'dy:raw', url, data: { data: { list: ['a'] } } }, '*')
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

    expect(post).toHaveBeenCalledWith({ type: 'dy:raw', url, data: { ok: 1 } }, '*')
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

  it('__dyHookInstalled 幂等守卫：重复执行只包装一次', () => {
    const { window } = createPage()
    const fetchStub = vi.fn(() => Promise.resolve(jsonResponse('https://x.com/a', { a: 1 })))
    window.fetch = fetchStub
    installFakeXhr(window)
    const origOpen = window.XMLHttpRequest.prototype.open

    window.eval(INJECT_SCRIPT)
    const wrappedFetch = window.fetch
    const wrappedOpen = window.XMLHttpRequest.prototype.open
    expect(window.__dyHookInstalled).toBe(true)
    expect(wrappedFetch).not.toBe(fetchStub)
    expect(wrappedOpen).not.toBe(origOpen)

    // 二次执行直接 return：fetch/XHR 引用不变（未被再次包装）
    window.eval(INJECT_SCRIPT)
    expect(window.__dyHookInstalled).toBe(true)
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
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(received).toEqual([{ type: 'dy:raw', url, data: { hot: ['a'] } }])
  })
})
