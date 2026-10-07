import { describe, it, expect, vi, afterEach } from 'vitest'

const cookies = vi.hoisted(() => ({ get: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, session: { fromPartition: vi.fn(() => ({ cookies })) } }))
import { VideoBrowser, JS_EVAL_TIMEOUT_MS } from '../src/main/browser'
import { getAdapter } from '../src/main/adapters'
import { session } from 'electron'

function setup(platform = 'douyin', title = '', url = getAdapter(platform)!.homeUrl) {
  const execute = vi.fn(async (_script?: string): Promise<unknown> => null)
  const frame = { url, framesInSubtree: [] as unknown[], executeJavaScript: execute }
  const wc = { getTitle: () => title, getURL: () => url, mainFrame: frame, executeJavaScript: execute }
  const b = new VideoBrowser({} as never)
  Object.assign(b, { win: { webContents: wc, isDestroyed: () => false }, current: getAdapter(platform) })
  return { b, frame, execute }
}
afterEach(() => { vi.useRealTimers(); cookies.get.mockReset(); cookies.get.mockResolvedValue([]) })

describe('主进程页面信号与分区登录状态', () => {
  it('空正文验证码中间页直接命中标题，不等待页面脚本', async () => {
    const { b, execute } = setup('douyin', '验证码中间页')
    execute.mockImplementation(() => new Promise(() => {}))
    expect(await b.findVerifyIndicator()).toBe('验证码中间页')
    expect(execute).not.toHaveBeenCalled()
  })
  it('地址优先于标题，验证码地址无需页面脚本', async () => {
    const { b, execute } = setup('douyin', '验证码中间页', 'https://rmc.bytedance.com/verifycenter/captcha/v2')
    expect(await b.findVerifyIndicator()).toContain('地址命中')
    expect(execute).not.toHaveBeenCalled()
  })
  it('关键词 captcha 的正常搜索地址不算验证页', async () => {
    const { b, execute } = setup('douyin', 'captcha - 抖音搜索', 'https://www.douyin.com/search/captcha')
    expect(await b.findVerifyIndicator()).toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('framesInSubtree 的跨域 URL 命中且 iframe 可见，返回验证', async () => {
    const { b, frame, execute } = setup()
    frame.framesInSubtree = [frame, { url: 'https://rmc.bytedance.com/verifycenter/captcha/v2', parent: frame }]
    execute.mockResolvedValue(true)
    expect(await b.findVerifyIndicator()).toContain('帧地址命中')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).not.toContain('contentDocument')
  })
  it('隐藏验证 frame 或后台 nocaptcha 资源不误报', async () => {
    const { b, frame, execute } = setup()
    frame.framesInSubtree = [frame, { url: 'https://rmc.bytedance.com/verifycenter/captcha/v2', parent: frame }, { url: 'https://static.test/rmc-nocaptcha/index.html', parent: frame }]
    execute.mockResolvedValueOnce(false).mockResolvedValueOnce(null)
    expect(await b.findVerifyIndicator()).toBeNull()
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('快手页面登录信号给出未登录', async () => {
    const { b, execute } = setup('kuaishou')
    execute.mockResolvedValue('logged_out')
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'logged_out' })
  })
  it('登录提示优先于可能已失效的 Cookie', async () => {
    const { b, execute } = setup('xiaohongshu')
    execute.mockResolvedValue('logged_out')
    cookies.get.mockResolvedValue([{ name: 'web_session', value: 'opaque' }])
    expect(await b.getLoginStatus(getAdapter('xiaohongshu')!)).toMatchObject({ status: 'logged_out' })
  })
  it('切换平台后保留已核实的页面状态，Cookie 改变后退回未知', async () => {
    const { b, execute } = setup('kuaishou')
    execute.mockResolvedValue('logged_out')
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'logged_out' })
    Object.assign(b, { win: null, current: getAdapter('douyin') })
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'logged_out' })
    cookies.get.mockResolvedValue([{ name: 'new-cookie', value: 'new-session' }])
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'unknown' })
  })
  it('平台尚未打开，查询已核实的登录 Cookie，使用对应分区且不导航', async () => {
    const { b, execute } = setup('douyin')
    cookies.get.mockResolvedValue([{ name: 'web_session', value: 'opaque', expirationDate: Date.now() / 1000 + 600 }])
    expect(await b.getLoginStatus(getAdapter('xiaohongshu')!)).toMatchObject({ status: 'logged_in' })
    expect(session.fromPartition).toHaveBeenCalledWith('persist:xiaohongshu')
    expect(execute).not.toHaveBeenCalled()
  })
  it('真机抖音 sessionid Cookie 表示已登录，游客 Cookie 不代表登录', async () => {
    const { b } = setup('kuaishou')
    cookies.get.mockResolvedValue([{ name: 'sessionid', value: 'opaque', expirationDate: Date.now() / 1000 + 600 }])
    expect(await b.getLoginStatus(getAdapter('douyin')!)).toMatchObject({ status: 'logged_in' })
    cookies.get.mockResolvedValue([{ name: 'ttwid', value: 'guest' }])
    expect(await b.getLoginStatus(getAdapter('douyin')!)).toMatchObject({ status: 'unknown' })
  })
  // 每一项是一组 Cookie（外面再包一层数组：it.each 会把每一项展开成参数）
  it.each<[Array<{ name: string; value: string; expirationDate?: number }>]>([
    [[]], [[{ name: 'did', value: 'guest' }]], [[{ name: 'web_session', value: '' }]],
    [[{ name: 'web_session', value: 'expired', expirationDate: 1 }]]
  ])('Cookie 缺失、游客、空值或过期保持未知 %#', async value => {
    const { b } = setup('douyin')
    cookies.get.mockResolvedValue(value)
    expect(await b.getLoginStatus(getAdapter('xiaohongshu')!)).toMatchObject({ status: 'unknown' })
  })
  it('登录查询脚本卡住也有超时，不阻塞调度器', async () => {
    vi.useFakeTimers()
    const { b, execute } = setup()
    execute.mockImplementation(() => new Promise(() => {}))
    const result = b.findLoginIndicator()
    await vi.advanceTimersByTimeAsync(JS_EVAL_TIMEOUT_MS)
    expect(await result).toBeNull()
  })
})
