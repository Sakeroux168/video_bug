// src/renderer/src/components/authorsCsv.ts — 作者表的 CSV 导入/导出（纯函数）
//
// 用户诉求：手上有现成的作者表，只要里面有「作者名」和「主页链接」两列就该能导进来，
// **不管其他列是什么东西**。所以不能要求固定列序、固定表头，得自己认列。

import { neutralizeCsvFormula } from '../../../shared/csvSafe'

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
  // 表头认不出时（例如「作者链接,粉丝数」——单个表头同时命中名称词与链接词，
  // 又没有第二列能当名称），不能直接把第一行当数据：表头文字会变成一条
  // 莫名的失败行，用户会以为自己表格第一行有问题。
  // 判定：第一行没有任何像链接的单元格，而后续行有 → 它是表头。
  // 加「后续行有」这个条件是为了避免整个文件都没链接时静默丢掉第一条真数据。
  const looksLikeHeaderRow =
    !byHeader && rows.length > 1 &&
    !rows[0].some(looksLikeUrl) && rows.slice(1).some(r => r.some(looksLikeUrl))
  const body = byHeader ? rows.slice(1) : (looksLikeHeaderRow ? rows.slice(1) : rows)

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
function esc(raw: string): string {
  // 先防公式注入（Excel 会执行 = + - @ 开头的单元格），再按 CSV 规则加引号
  const v = neutralizeCsvFormula(raw)
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

// ==========================
// 文件字节 → 文本
// ==========================

export type DecodeResult = { ok: true; text: string } | { ok: false; error: string }

/** 文件头魔数：识别「用户选错文件类型」而不是把二进制当文本硬读 */
const MAGIC: Array<{ sig: number[]; msg: string }> = [
  // .xlsx/.xlsm 本质是 zip
  { sig: [0x50, 0x4b, 0x03, 0x04], msg: '这看起来是 Excel 文件（.xlsx）。请在 Excel 里「文件 → 另存为」，格式选「CSV UTF-8（逗号分隔）」，再选那个 .csv 文件。' },
  // .xls 老版 OLE 复合文档
  { sig: [0xd0, 0xcf, 0x11, 0xe0], msg: '这看起来是老版 Excel 文件（.xls）。请在 Excel 里「文件 → 另存为」，格式选「CSV UTF-8（逗号分隔）」，再选那个 .csv 文件。' }
]

/**
 * 把选中文件的字节解成 CSV 文本。
 *
 * 两件事必须在这里做掉，否则用户会拿到满屏乱码却不知道为什么：
 *   1. **认出根本不是 CSV 的文件**（.xlsx 是 zip、.xls 是 OLE），直接给出可操作的提示。
 *      此前直接 file.text() 硬读，压缩包字节被当成几十行数据，产出一堆「未识别」的假失败行。
 *   2. **GBK 兜底**：中文 Windows 的 Excel「另存为 CSV」默认就是 GBK，按 UTF-8 解必然乱码。
 *      判据是 UTF-8 解码后出现替换字符 U+FFFD——这是解码器明确表示「这段字节不是合法 UTF-8」。
 */
export function decodeCsvBytes(buf: ArrayBuffer): DecodeResult {
  const u8 = new Uint8Array(buf)
  for (const m of MAGIC) {
    if (m.sig.every((b, i) => u8[i] === b)) return { ok: false, error: m.msg }
  }

  const asUtf8 = new TextDecoder('utf-8').decode(u8)
  if (!asUtf8.includes('\uFFFD')) return { ok: true, text: asUtf8.replace(/^\uFEFF/, '') }

  try {
    const asGbk = new TextDecoder('gbk').decode(u8)
    // GBK 也解不干净就退回 UTF-8 结果：至少 ASCII 部分是对的，用户还能看出个大概
    if (!asGbk.includes('\uFFFD')) return { ok: true, text: asGbk.replace(/^\uFEFF/, '') }
  } catch { /* 运行环境不支持 gbk：退回 UTF-8 */ }

  return { ok: true, text: asUtf8.replace(/^\uFEFF/, '') }
}
