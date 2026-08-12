// src/renderer/src/components/authorsCsv.ts — 作者表的 CSV 导入/导出（纯函数）
//
// 用户诉求：手上有现成的作者表，只要里面有「作者名」和「主页链接」两列就该能导进来，
// **不管其他列是什么东西**。所以不能要求固定列序、固定表头，得自己认列。

/** 一行一行地切 CSV：引号内的逗号、换行、两连双引号转义都要正确处理（Excel 导出的标准形态） */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // 去掉 Excel 常加的 BOM，否则第一个表头会带上不可见字符、匹配不上
  const s = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } // "" → 转义的一个 "
        else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  row.push(field)
  rows.push(row)
  // 丢掉全空行（结尾换行、Excel 常见的尾随空行）
  return rows.filter(r => r.some(x => x.trim() !== ''))
}

const NAME_HINTS = ['作者', '昵称', '名称', '名字', 'name', 'nickname', 'author']
const URL_HINTS = ['链接', '主页', '地址', '网址', 'url', 'link', 'home']

/** 表头认列；认不出返回 null，交给按内容猜 */
function pickByHeader(header: string[]): { name: number; url: number } | null {
  const norm = header.map(h => h.trim().toLowerCase())
  const url = norm.findIndex(h => URL_HINTS.some(k => h.includes(k)))
  // 名称列不能和链接列是同一列（「主页链接」同时含「主页」和「链接」，但不含名称词）
  const name = norm.findIndex((h, i) => i !== url && NAME_HINTS.some(k => h.includes(k)))
  if (url === -1 || name === -1) return null
  return { name, url }
}

const looksLikeUrl = (v: string): boolean => /douyin\.com|^https?:\/\//i.test(v.trim())

/**
 * 解析作者表 CSV → [{nickname, url}]。
 * **不做任何合法性校验**：缺名称/缺链接的行照样产出，交给主进程逐行给出原因，
 * 与手工粘贴走完全同一条校验链路（平台知识只在 adapter 里留一份）。
 */
export function parseAuthorsCsv(text: string): Array<{ nickname: string; url: string }> {
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []

  const byHeader = pickByHeader(rows[0])
  const body = byHeader ? rows.slice(1) : rows

  return body.map(r => {
    if (byHeader) {
      return { nickname: (r[byHeader.name] ?? '').trim(), url: (r[byHeader.url] ?? '').trim() }
    }
    // 没有可识别表头：含 douyin.com / http 的列当链接，其余第一个非空当名称
    const urlIdx = r.findIndex(looksLikeUrl)
    const url = urlIdx === -1 ? '' : r[urlIdx].trim()
    const nickname = (r.find((v, i) => i !== urlIdx && v.trim() !== '') ?? '').trim()
    return { nickname, url }
  })
}

/** CSV 字段转义：含逗号/引号/换行时必须整体加引号，内部引号翻倍 */
function esc(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * 导出作者表 → CSV。**只导作者与主页链接两列**（用户明确要求），
 * 用 CRLF 行尾：Excel 对 LF 的兼容性不如 CRLF。
 */
export function buildAuthorsCsv(rows: Array<{ nickname: string; home_url: string | null }>): string {
  const lines = ['作者,主页链接', ...rows.map(r => `${esc(r.nickname)},${esc(r.home_url ?? '')}`)]
  return lines.join('\r\n')
}
