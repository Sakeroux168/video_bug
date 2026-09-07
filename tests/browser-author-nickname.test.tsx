// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { VideoBrowser } from '../src/main/browser'

// 从作者主页读昵称，用于导入作者的「名称强绑定链接」校验。
//
// 关键决策：**不靠哈希类名**。交接文档「已知坑 1」写明抖音的哈希类名每次发版都可能变，
// 靠它取昵称等于埋一颗定时炸弹。这里优先用 og:title / document.title —— 这两个是给
// 搜索引擎和分享卡片用的，抖音没有动机去混淆，稳定性远高于 DOM 结构。

function makeBrowserWithDom(): VideoBrowser {
  const executeJavaScript = async (script: string): Promise<unknown> =>
    new Function('window', 'document', 'return (' + script + ')')(window, document)
  const b = new VideoBrowser({} as never)
  ;(b as unknown as { win: unknown }).win = { webContents: { executeJavaScript } }
  return b
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  document.title = ''
})

describe('readAuthorNickname', () => {
  it('优先取 og:title，并剥掉「的主页」「- 抖音」这类后缀', async () => {
    document.head.innerHTML = '<meta property="og:title" content="张三的主页 - 抖音">'
    document.title = '别的标题'
    expect(await makeBrowserWithDom().readAuthorNickname()).toBe('张三')
  })

  it('没有 og:title 时回落到 document.title', async () => {
    document.title = '李四的主页 - 抖音'
    expect(await makeBrowserWithDom().readAuthorNickname()).toBe('李四')
  })

  it('昵称本身含「主页」二字不会被误剥', async () => {
    document.title = '主页装修师的主页 - 抖音'
    expect(await makeBrowserWithDom().readAuthorNickname()).toBe('主页装修师')
  })

  it('标题里没有可用昵称 → null（调用方据此判定校验失败，不放行）', async () => {
    document.title = '抖音'
    expect(await makeBrowserWithDom().readAuthorNickname()).toBeNull()
  })

  it('页面还没加载出标题 → null', async () => {
    document.title = ''
    expect(await makeBrowserWithDom().readAuthorNickname()).toBeNull()
  })

  it('emoji 与空格原样保留，交给昵称匹配层去规范化', async () => {
    document.head.innerHTML = '<meta property="og:title" content="张三 🌟日常的主页 - 抖音">'
    expect(await makeBrowserWithDom().readAuthorNickname()).toBe('张三 🌟日常')
  })
})
