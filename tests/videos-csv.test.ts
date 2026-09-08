import { describe, it, expect } from 'vitest'
import { buildVideosCsv, toVideoExportRows } from '../src/renderer/src/components/videosCsv'
import type { VideoRow } from '../src/shared/types'

// 员工要一份可以交出去的表格：作者名、原视频标题、原视频链接、点赞、评论，
// 外加平台、时长、本地文件名。
//
// 最要紧的一条：评论数「未知」必须是空单元格，不能写 0。
// 快手的搜索接口根本不返回评论数（20 条真机样本里那个像评论数的字段恒为 0，
// 点赞 22 万的那条也是 0，已确认不是评论数）。写 0 会让人以为真没人评论。

function video(over: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 1, platform: 'douyin', task_id: 1, aweme_id: 'AW1', title: '标题',
    author_id: 1, play_addr: 'https://cdn.test/v.mp4',
    source_url: 'https://www.douyin.com/video/AW1',
    duration: 12, cover_url: null, cover_path: null, original_path: null,
    normalization_error: null, video_width: 1080, video_height: 1920,
    publish_time: '2026-09-07T00:00:00.000Z',
    stats: JSON.stringify({ likes: 42, comments: 17 }),
    ai_verdict: 'pass', ai_tags: null, status: 'done',
    local_path: 'D:\\下载\\美食\\张三\\竖屏\\一分钟内\\标题.mp4',
    file_size: 100, error: null, retry_count: 0,
    fetched_at: '2026-09-07T00:00:00.000Z', downloaded_at: '2026-09-07T00:01:00.000Z',
    author_nickname: '张三',
    ...over
  }
}

const label = (p: string): string => (p === 'kuaishou' ? '快手' : p === 'douyin' ? '抖音' : p)

describe('toVideoExportRows', () => {
  it('从视频行取出八列：平台显示名、作者、标题、作品链接、点赞、评论、时长、文件名', () => {
    expect(toVideoExportRows([video()], label)).toEqual([{
      platform: '抖音',
      author: '张三',
      title: '标题',
      sourceUrl: 'https://www.douyin.com/video/AW1',
      likes: 42,
      comments: 17,
      durationSec: 12,
      fileName: '标题.mp4'
    }])
  })

  it('本地文件名只取文件名，不带目录（Windows 反斜杠与 POSIX 斜杠都要认）', () => {
    expect(toVideoExportRows([video({ local_path: 'C:\\a\\b\\片子.mp4' })], label)[0].fileName).toBe('片子.mp4')
    expect(toVideoExportRows([video({ local_path: '/home/u/片子.mp4' })], label)[0].fileName).toBe('片子.mp4')
  })

  it('还没下载（local_path 为空）→ 文件名留空，不编一个出来', () => {
    expect(toVideoExportRows([video({ local_path: null })], label)[0].fileName).toBe('')
  })

  it('评论未知 → null（快手就是这种），不伪装成 0', () => {
    const rows = toVideoExportRows([video({ stats: JSON.stringify({ likes: 700, comments: null }) })], label)
    expect(rows[0].comments).toBeNull()
    expect(rows[0].likes).toBe(700)
  })

  it('评论真实为 0 → 就是 0，不能跟未知混为一谈', () => {
    expect(toVideoExportRows([video({ stats: JSON.stringify({ likes: 1, comments: 0 }) })], label)[0].comments).toBe(0)
  })

  it('stats 缺失或不是合法 JSON → 点赞评论都按未知处理，不抛错', () => {
    for (const bad of ['', 'not json', '{', 'null']) {
      const r = toVideoExportRows([video({ stats: bad })], label)[0]
      expect(r.likes).toBeNull()
      expect(r.comments).toBeNull()
    }
  })

  it('作品链接缺失 → 留空（不猜、不拼一个可能打不开的地址）', () => {
    expect(toVideoExportRows([video({ source_url: null })], label)[0].sourceUrl).toBe('')
  })

  it('作者昵称缺失 → 留空', () => {
    expect(toVideoExportRows([video({ author_nickname: null })], label)[0].author).toBe('')
  })

  it('未知平台回落原始名，不留空', () => {
    expect(toVideoExportRows([video({ platform: 'weibo' })], label)[0].platform).toBe('weibo')
  })
})

describe('buildVideosCsv', () => {
  const rows = toVideoExportRows([video()], label)

  it('表头就是用户要的列，顺序固定', () => {
    expect(buildVideosCsv(rows).split('\r\n')[0])
      .toBe('平台,作者,标题,作品链接,点赞,评论,时长(秒),本地文件名')
  })

  it('用 CRLF 换行（Excel 打开不粘行）', () => {
    expect(buildVideosCsv(rows)).toContain('\r\n')
  })

  it('未知的评论导出成空单元格，不是 0', () => {
    const unknown = toVideoExportRows([video({ stats: JSON.stringify({ likes: 5, comments: null }) })], label)
    const cells = buildVideosCsv(unknown).split('\r\n')[1].split(',')
    expect(cells[4]).toBe('5')
    expect(cells[5]).toBe('')
  })

  it('标题里的逗号、引号、换行按 CSV 规矩转义，不撑乱列', () => {
    const tricky = toVideoExportRows([video({ title: '标题,带"引号"\n还换行' })], label)
    const csv = buildVideosCsv(tricky)
    expect(csv).toContain('"标题,带""引号""\n还换行"')
    // 转义后整张表仍然只有表头 + 1 行数据（按 CRLF 切）
    expect(csv.split('\r\n')).toHaveLength(2)
  })

  it('时长保留小数（10-20 秒这类筛选靠的就是精确秒数）', () => {
    const frac = toVideoExportRows([video({ duration: 20.4 })], label)
    expect(buildVideosCsv(frac).split('\r\n')[1]).toContain('20.4')
  })

  it('空列表只输出表头，不产出空行', () => {
    expect(buildVideosCsv([])).toBe('平台,作者,标题,作品链接,点赞,评论,时长(秒),本地文件名')
  })
})
