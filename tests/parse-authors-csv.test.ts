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

  // 边界（测试工程师第16轮补）：表头单元格同时命中名称词与链接词（如「作者链接」同时含
  // 「作者」和「链接」）。当前实现：url 列用 findIndex 抢到这一列后，name 列的搜索把它排除，
  // 结果整个表头都识别不出来（这个例子里没有别的候选列能命中名称词）→ pickByHeader 返回 null
  // → 退化为「按内容猜」路径，而该路径假定 rows[0] 也是数据行，把表头原样当成一条作者记录
  // 产出（此处是 {nickname:'作者链接', url:''}）。锁住这个现状：它不会破坏后面真实数据行的解析，
  // 但会在结果集开头多出一条来自表头文字的假记录（导入时会作为失败行呈现，容易让用户误以为
  // 自己的表格第一行数据有问题）。是否需要改进列识别 / 表头检测逻辑，留给项目负责人裁决。
  it('【现状锁定】表头列同时含名称词+链接词、且无其它候选名称列 → 表头识别失败，表头行本身被当成一条数据行产出', () => {
    const csv = '作者链接,备注\n张三,随便写\n李四,备注2'
    const rows = parseAuthorsCsv(csv)
    expect(rows).toEqual([
      { nickname: '作者链接', url: '' }, // ← 表头本身泄漏成的假记录
      { nickname: '张三', url: '' },
      { nickname: '李四', url: '' }
    ])
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

  // 边界（测试工程师第16轮补）：制表符与中文全角引号都不是 CSV 语法里的特殊字符（只有半角
  // 双引号 " 才是），esc() 只认半角引号/逗号/CR/LF。制表符、中文弯引号原样直接写出、不加包裹，
  // 且不影响往返解析——因为它们既不是字段分隔符也不会截断字段。
  it('名称含制表符 → 不加引号包裹地原样导出，导入回来后仍是同一个值（制表符不是 CSV 分隔符，不需转义）', () => {
    const rows = [{ nickname: '张三\t日常', home_url: 'https://www.douyin.com/user/a' }]
    const csv = buildAuthorsCsv(rows)
    expect(csv).toContain('张三\t日常,https://www.douyin.com/user/a') // 未被引号包裹
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '张三\t日常', url: 'https://www.douyin.com/user/a' }])
  })

  it('名称含中文全角弯引号（“”）→ 不触发转义（只有半角 " 是 CSV 特殊字符），往返解析值不变', () => {
    const rows = [{ nickname: '“张三”', home_url: 'https://www.douyin.com/user/a' }]
    const csv = buildAuthorsCsv(rows)
    expect(csv).toContain('“张三”,https://www.douyin.com/user/a') // 未被引号包裹，弯引号原样输出
    expect(parseAuthorsCsv(csv)).toEqual([{ nickname: '“张三”', url: 'https://www.douyin.com/user/a' }])
  })
  // 测试工程师报的缺陷：表头单元格同时命中名称词与链接词（如「作者链接」）、
  // 且没有第二列能命中名称词时，表头识别整体失败 → 退化成按内容猜列，
  // 而按内容猜列不会跳过表头行，于是**表头文字本身变成一条假数据**，
  // 导入结果里凭空多出一条莫名失败行，用户会以为自己表格第一行有问题。
  it('表头认不出时，不把表头行当数据吐出来', () => {
    const csv = ['作者链接,粉丝数','张三 https://www.douyin.com/user/a,10万'].join('\n')
    // 第一行没有任何像链接的单元格，而后续行有 → 它是表头，该丢
    const r = parseAuthorsCsv(csv)
    expect(r.every(x => x.nickname !== '作者链接')).toBe(true)
    expect(r.length).toBe(1)
  })

  it('整个文件都没有链接时，不能把第一行当表头丢掉（否则静默丢数据）', () => {
    const csv = ['张三,', '李四,'].join('\n')
    expect(parseAuthorsCsv(csv).length).toBe(2)
  })

})
