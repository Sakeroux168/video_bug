import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 话题 token。
 *
 * 判据是「# 前面不是 ASCII 字母或数字」：
 *   - `…点名。#搞笑`、`好日子！#搞笑`、`结束了，#农村生活` 都算话题
 *     （真机实测漏网过——原来要求 # 前必须是空格，而中文标题里句号紧跟话题极常见）
 *   - `C#教程`、`F#` 不算，井号前是字母
 *
 * 连续话题 `#a#b` 里第二个 # 前面是字母，单趟扫不掉，所以 stripHashtags 循环到稳定。
 */
const HASHTAG_RE = /(?<![A-Za-z0-9])#[^#\s]+/g

/** 反复剥到不再变化：处理 `#a#b` 这种紧挨着的话题串 */
function stripHashtags(value: string): string {
  let out = value
  for (let i = 0; i < 10; i++) {
    const next = out.replace(HASHTAG_RE, ' ')
    if (next === out) break
    out = next
  }
  return out
}

/** Windows 非法字符替换 + 空白收敛 */
function sanitize(value: string): string {
  return value.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim()
}

/**
 * 下载文件名的主体。
 *
 * 员工反馈：文件名里作者名、话题和标题混在一起，只想要标题。
 * 抖音/快手的标题字段本身就是「正文 + 一串 #话题」，话题不是我们加的；
 * 作者名和作品 ID 是我们拼的，现已去掉。
 *
 * 取名优先级：
 *   1. 剥掉 #话题 后的正文
 *   2. 正文为空（实测约 15% 的作品标题只有话题）→ 用话题词本身，去掉 # 号
 *   3. 连话题都没有 → 作品 ID（没有任何可读信息了，但至少能反查原作品）
 *   4. 作品 ID 也为空 → 作者名 → 最后兜 'video'，保证永远不会产出空文件名
 *
 * 重名不在这里处理：ensureUniqueStem 会在目标目录冲突时追加 _1 _2，
 * 视频与封面共用同一主体名。
 */
export function safeFilename(title: string, author: string, awemeId: string): string {
  const raw = title ?? ''
  const body = sanitize(stripHashtags(raw))
  const tagWords = sanitize([...raw.matchAll(HASHTAG_RE)].map(m => m[0].slice(1)).join(' '))
  const base = body || tagWords || sanitize(awemeId) || sanitize(author) || 'video'
  return base.length > 80 ? base.slice(0, 80).trim() : base
}

export function ensureUniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  while (existsSync(join(dir, `${stem}_${i}${ext}`))) i++
  return `${stem}_${i}${ext}`
}

/** 为同一视频的 MP4 与封面选择一个共同且未占用的文件名主体。 */
/** isTaken：额外判定「名字已被占」（如另一条正在下载、还没落盘的同名视频），盘上不存在也要跳过 */
export function ensureUniqueStem(dir: string, stem: string, extensions: string[], isTaken?: (candidate: string) => boolean): string {
  const occupied = (candidate: string): boolean =>
    (isTaken?.(candidate) ?? false) || extensions.some(ext => existsSync(join(dir, `${candidate}${ext}`)))
  if (!occupied(stem)) return stem
  let i = 1
  while (occupied(`${stem}_${i}`)) i++
  return `${stem}_${i}`
}
