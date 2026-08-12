import { describe, it, expect } from 'vitest'
import { parseAuthorsCsv, buildAuthorsCsv } from '../src/renderer/src/components/authorsCsv'

// 用户诉求：手上有现成的作者表（Excel/CSV），只要里面有「作者名」和「主页链接」两列，
// 就应该能导进来，**不管其他列是什么东西**。所以不能要求固定列序、固定表头。

describe('parseAuthorsCsv：列识别', () => {
  it('按表头关键词识别，忽略其余所有列', () => {
    const csv = '序号,作者昵称,粉丝数,主页链接,备注\n1,张三,10万,https://www.douyin.com/user/a,随便写\n2,李四,5万,https://www.douyin.com/user/b,'
    expect(parseAuthorsCsv(csv)).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', url: 'https://www.douyin.com/user/b' }
    ])
  })

  it('表头换种叫法也认（作者/名称/链接/网址/url）', () => {
    const csv = '作者,url\n张三,https://www.douyin.com/user/a'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/a' }])
  })

  it('没有可识别表头 → 按内容猜：含 douyin.com 的列是链接，另一列取第一个非空当名称', () => {
    const csv = '张三,https://www.douyin.com/user/a\n李四,https://www.douyin.com/user/b'
    expect(parseAuthorsCsv(csv)).toEqual([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', url: 'https://www.douyin.com/user/b' }
    ])
  })

  it('链接列在前、名称列在后也能认', () => {
    const csv = 'https://www.douyin.com/user/a,张三'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/a' }])
  })
})

describe('parseAuthorsCsv：CSV 语法', () => {
  it('引号包裹的字段里可以有逗号（Excel 导出的标准形态）', () => {
    const csv = '作者,链接\n"张三,爱做饭",https://www.douyin.com/user/a'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三,爱做饭', url: 'https://www.douyin.com/user/a' }])
  })

  it('引号内的两个连续双引号是转义的一个双引号', () => {
    const csv = '作者,链接\n"张三""官方""",https://www.douyin.com/user/a'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三"官方"', url: 'https://www.douyin.com/user/a' }])
  })

  it('引号字段里可以有换行，不会被当成新的一行', () => {
    const csv = '作者,链接\n"张三\n日常",https://www.douyin.com/user/a'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三\n日常', url: 'https://www.douyin.com/user/a' }])
  })

  it('CRLF、空行、BOM 都能容忍', () => {
    const csv = '\uFEFF作者,链接\r\n张三,https://www.douyin.com/user/a\r\n\r\n'
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三', url: 'https://www.douyin.com/user/a' }])
  })

  it('缺名称或缺链接的行照样产出（交给主进程逐行给原因，渲染层不做校验）', () => {
    const csv = '作者,链接\n张三,\n,https://www.douyin.com/user/b'
    expect(parseAuthorsCsv(csv)).toEqual([
      { nickname: '张三', url: '' },
      { nickname: '', url: 'https://www.douyin.com/user/b' }
    ])
  })

  it('空文件 / 只有表头 → 空数组', () => {
    expect(parseAuthorsCsv('')).toEqual([])
    expect(parseAuthorsCsv('作者,链接')).toEqual([])
  })
})

describe('buildAuthorsCsv：导出', () => {
  it('只导出作者与主页链接两列，带表头', () => {
    const csv = buildAuthorsCsv([
      { nickname: '张三', home_url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', home_url: null }
    ])
    expect(csv.split('\r\n')[0]).toBe('作者,主页链接')
    expect(csv).toContain('张三,https://www.douyin.com/user/a')
    expect(csv).toContain('李四,')
  })

  it('名称含逗号/引号/换行时按 CSV 规则转义，导出后能原样再导入', () => {
    const rows = [{ nickname: '张三,爱"做饭"\n每天', home_url: 'https://www.douyin.com/user/a' }]
    const round = parseAuthorsCsv(buildAuthorsCsv(rows))
    expect(round).toEqual([{ nickname: '张三,爱"做饭"\n每天', url: 'https://www.douyin.com/user/a' }])
  })
})
