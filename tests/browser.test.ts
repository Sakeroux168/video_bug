import { describe, it, expect, vi } from 'vitest'
import { VideoBrowser, VERIFY_TEXT_PATTERN, withTimeout } from '../src/main/browser'

function makeBrowser(): { b: VideoBrowser } {
  const b = new VideoBrowser({} as never, () => {})
  return { b }
}

describe('验证码识别与长操作强制超时（R11-4）', () => {
  it('验证码匹配正则：常见文案命中', () => {
    // R11-5 扩展词：机器人验证/完成拼图/点击完成/安全校验/verify/captcha（抖音实际文案漏词修复）
    for (const t of ['请完成验证', '拖动滑块完成验证', '安全验证', '滑动验证', '请输入验证码', '验证码错误',
      '机器人验证', '请完成拼图验证', '点击完成验证', '安全校验', 'verify you are human', 'captcha-required']) {
      expect(VERIFY_TEXT_PATTERN.test(t)).toBe(true)
    }
  })

  it('验证码匹配正则：普通文案不误命中', () => {
    for (const t of ['暂时没有更多了', '加载更多', '热门搜索', '点赞']) {
      expect(VERIFY_TEXT_PATTERN.test(t)).toBe(false)
    }
  })

  it('withTimeout：操作永不 resolve → 超时 reject OP_TIMEOUT（不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const p = withTimeout(new Promise(() => {}), 31000, '页面加载')
      const codes: string[] = []
      void p.catch(e => codes.push((e as { code?: string }).code ?? ''))
      await vi.advanceTimersByTimeAsync(30000)
      expect(codes).toEqual([]) // 30s 未到不触发
      await vi.advanceTimersByTimeAsync(1000)
      expect(codes).toEqual(['OP_TIMEOUT'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('withTimeout：操作先完成 → 正常透传结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok')
  })

  it('load 永不 resolve → 30s 强制超时走超时路径（任务不永久挂起）', async () => {
    vi.useFakeTimers()
    try {
      const { b } = makeBrowser()
      const never = new Promise<void>(() => {})
      ;(b as unknown as { win: unknown }).win = { loadURL: () => never }
      const p = b.load({} as never, 'https://www.douyin.com/search/x').catch(e => e)
      await vi.advanceTimersByTimeAsync(31000)
      const r = await p
      expect(r).toMatchObject({ code: 'OP_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  }, 15000)

  it('scrollToBottom 脚本永不返回 → 60s 超时视为滚动结束返回（不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const { b } = makeBrowser()
      const wc = { executeJavaScript: vi.fn(() => new Promise(() => {})) }
      ;(b as unknown as { win: unknown }).win = { webContents: wc }
      const p = b.scrollToBottom({ waitMs: 8000 })
      let done = false
      void p.then(() => { done = true })
      await vi.advanceTimersByTimeAsync(61000)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 15000)
})
