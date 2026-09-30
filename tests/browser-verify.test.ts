// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { buildLoginScript, buildVerifyScript } from '../src/main/browser'

/** 在 jsdom 全局作用域执行检测脚本并取其 IIFE 返回值（new Function 函数体需显式 return） */
function runVerifyScript(): string | null {
  return new Function(`return ${buildVerifyScript()}`)() as string | null
}

function runLoginScript(platform: string): string | null {
  return new Function(`return ${buildLoginScript(platform)}`)() as string | null
}

/** jsdom 单测 findVerifyIndicator 页面脚本：结构检测（验证弹窗类名）+ 文字匹配（扩展正则）命中逻辑。
 *  jsdom 的 getBoundingClientRect 恒 0 → 覆写原型让所有元素"可见且视口内"，脚本的 inView 判定才生效。 */
describe('findVerifyIndicator 页面脚本（R11-4/5）', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = () =>
      ({ width: 100, height: 100, top: 0, bottom: 100 }) as DOMRect
  })

  it('可见 captcha 类名弹窗 + 匹配文案 → 返回命中文案', () => {
    document.body.innerHTML = '<div class="captcha-modal"><div>拖动滑块完成验证</div></div>'
    const r = runVerifyScript()
    expect(r).toContain('拖动滑块完成验证')
  })

  it('可见 verify 结构但无匹配文案 → 「验证弹窗（结构命中）」', () => {
    document.body.innerHTML = '<div class="verify-panel"><div>加载中…</div></div>'
    const r = runVerifyScript()
    expect(r).toBe('验证弹窗（结构命中）')
  })

  it('机器人验证文案（纯文字，无验证类名）→ 文字路径命中', () => {
    document.body.innerHTML = '<div><span>请完成机器人验证</span></div>'
    const r = runVerifyScript()
    expect(r).toContain('机器人验证')
  })

  it('普通文案无验证结构 → null（不误判）', () => {
    document.body.innerHTML = '<div><span>暂时没有更多了</span></div>'
    const r = runVerifyScript()
    expect(r).toBeNull()
  })

  it.each([
    ['xiaohongshu', '登录后查看搜索结果'],
    ['xiaohongshu', '登录即可查看 Ta 的笔记'],
    ['douyin', '扫码登录']
  ])('%s 未登录文案独立识别，且不再误报验证码', (platform, message) => {
    document.body.innerHTML = `<div class="dialog"><span>${message}</span></div>`
    expect(runLoginScript(platform)).toContain(message)
    expect(runVerifyScript()).toBeNull()
  })

  it('抖音登录框里的「验证码登录」选项不算验证码', () => {
    document.body.innerHTML = '<div class="dialog"><span>扫码登录</span><span>验证码登录</span><span>密码登录</span></div>'
    expect(runLoginScript('douyin')).toBeTruthy()
    expect(runVerifyScript()).toBeNull()
  })

  it('真实验证码即使同时有登录入口也仍按验证码识别', () => {
    document.body.innerHTML = '<div class="captcha-modal"><span>扫码登录</span><strong>拖动滑块完成验证</strong></div>'
    expect(runVerifyScript()).toContain('拖动滑块完成验证')
  })
})
