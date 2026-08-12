import { describe, it, expect } from 'vitest'
import { parsePastedAuthors } from '../src/renderer/src/components/parsePastedAuthors'

// 纯函数：把粘贴的多行文本拆成 {nickname, url} 数组。
// 渲染层不判断链接合法性/不解析 sec_uid——只负责「抓链接、剩下当名称」，校验交给主进程逐行给 reason。

describe('parsePastedAuthors', () => {
  it('名称含空格：不按空白 split，只把链接摘出去，其余整体 trim 作为 nickname', () => {
    const r = parsePastedAuthors('张三 の 日常 https://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '张三 の 日常', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('链接在前，名称在后', () => {
    const r = parsePastedAuthors('https://www.douyin.com/user/abc123 张三的日常')
    expect(r).toEqual([{ nickname: '张三的日常', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('Tab 分隔', () => {
    const r = parsePastedAuthors('张三\thttps://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('逗号分隔', () => {
    const r = parsePastedAuthors('张三,https://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('名称里带逗号：只摘链接，逗号留在名称里', () => {
    const r = parsePastedAuthors('张三,李四 https://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '张三,李四', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('多个连续空格', () => {
    const r = parsePastedAuthors('张三     https://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('空行/纯空白行直接忽略，不产出条目', () => {
    const r = parsePastedAuthors('张三 https://www.douyin.com/user/a\n\n   \n李四 https://www.douyin.com/user/b')
    expect(r).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', url: 'https://www.douyin.com/user/b' }
    ])
  })

  it('只有链接没有名称：nickname 为空字符串，仍产出条目', () => {
    const r = parsePastedAuthors('https://www.douyin.com/user/abc123')
    expect(r).toEqual([{ nickname: '', url: 'https://www.douyin.com/user/abc123' }])
  })

  it('只有名称没有链接：url 为空字符串，仍产出条目', () => {
    const r = parsePastedAuthors('张三的日常')
    expect(r).toEqual([{ nickname: '张三的日常', url: '' }])
  })

  it('兼容 CRLF 换行', () => {
    const r = parsePastedAuthors('张三 https://www.douyin.com/user/a\r\n李四 https://www.douyin.com/user/b\r\n')
    expect(r).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', url: 'https://www.douyin.com/user/b' }
    ])
  })

  // 审查补：逗号紧跟链接、中间无空格时，原实现的 /https?:\/\/\S+/ 会把逗号和后面的名称
  // 一起吞进 URL —— 名称和链接双双报废，用户只看到「未识别到抖音主页链接」，无从判断原因。
  // 从 Excel 拷贝时「链接在前、逗号分隔」是很可能的排列。
  it('链接在前、逗号分隔且无空格 → 链接与名称都能正确切出', () => {
    expect(parsePastedAuthors('https://www.douyin.com/user/abc,张三')).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/abc' }
    ])
  })

  it('中文逗号 / 顿号 / 分号 同样能作分隔符', () => {
    expect(parsePastedAuthors('https://www.douyin.com/user/a，张三')).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' }
    ])
    expect(parsePastedAuthors('https://www.douyin.com/user/b、李四')).toEqual([
      { nickname: '李四', url: 'https://www.douyin.com/user/b' }
    ])
    expect(parsePastedAuthors('https://www.douyin.com/user/c；王五')).toEqual([
      { nickname: '王五', url: 'https://www.douyin.com/user/c' }
    ])
  })

})
