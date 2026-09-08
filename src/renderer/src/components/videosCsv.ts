import type { VideoRow } from '../../../shared/types'

/**
 * 视频数据导出表。员工要一份能交出去的表格：作者名、原视频标题、原视频链接、
 * 点赞、评论，外加平台、时长、本地文件名。
 *
 * 用 CSV 而不是 xlsx：仓库里已有同款轮子（作者表导出），零新依赖，
 * 也就不用为一个导出功能去过第三方许可检查。
 */
export interface VideoExportRow {
  platform: string
  author: string
  title: string
  sourceUrl: string
  /** null = 未知。不能写 0——那是「真的零个赞」的意思 */
  likes: number | null
  /** null = 未知。快手搜索接口不返回评论数，这一列对快手就是空的 */
  comments: number | null
  durationSec: number
  fileName: string
}

/** 只取文件名。Windows 反斜杠与 POSIX 斜杠都要认（库里两种都可能有） */
function baseName(path: string | null): string {
  if (!path) return ''
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut >= 0 ? path.slice(cut + 1) : path
}

/** stats 是入库时序列化的 JSON 字符串；坏数据一律按未知处理，不让导出整个失败 */
function readStats(stats: string): { likes: number | null; comments: number | null } {
  try {
    const parsed = JSON.parse(stats) as { likes?: unknown; comments?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return { likes: null, comments: null }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return { likes: num(parsed.likes), comments: num(parsed.comments) }
  } catch {
    return { likes: null, comments: null }
  }
}

/** 视频行 → 导出行。platformLabel 把 douyin/kuaishou 转成中文显示名，未知平台回落原始名。 */
export function toVideoExportRows(rows: VideoRow[], platformLabel: (name: string) => string): VideoExportRow[] {
  return rows.map(r => {
    const { likes, comments } = readStats(r.stats)
    return {
      platform: platformLabel(r.platform),
      author: r.author_nickname ?? '',
      title: r.title ?? '',
      // 作品链接缺失就留空：不猜、不拼一个可能打不开的地址
      sourceUrl: r.source_url ?? '',
      likes,
      comments,
      durationSec: r.duration,
      fileName: baseName(r.local_path)
    }
  })
}

const HEADER = '平台,作者,标题,作品链接,点赞,评论,时长(秒),本地文件名'

function esc(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 未知计数导出成空单元格。写 0 会让人以为真的零评论——既有红线。 */
function num(v: number | null): string {
  return v === null ? '' : String(v)
}

/** CRLF 换行：Excel 打开 LF 的 CSV 会把整张表挤成一行 */
export function buildVideosCsv(rows: VideoExportRow[]): string {
  const lines = [HEADER, ...rows.map(r => [
    esc(r.platform), esc(r.author), esc(r.title), esc(r.sourceUrl),
    num(r.likes), num(r.comments), String(r.durationSec), esc(r.fileName)
  ].join(','))]
  return lines.join('\r\n')
}

/** 把 CSV 文本存成文件。加 BOM：Excel 不带 BOM 打开 UTF-8 CSV 会把中文显示成乱码。 */
export function saveCsvFile(csv: string, fileName: string): void {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出文件名统一带日期，方便员工分辨哪次导的 */
export function csvFileName(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`
}
