import { existsSync } from 'fs'
import { join } from 'path'

/** 只在词首认 #：`#话题` 是话题，`C#教程` 里的 # 不是。捕获前导空白以便替换后不粘连。 */
const HASHTAG_RE = /(^|\s)#([^#\s]+)/g

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
  const body = sanitize(raw.replace(HASHTAG_RE, '$1'))
  const tagWords = sanitize([...raw.matchAll(HASHTAG_RE)].map(m => m[2]).join(' '))
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
export function ensureUniqueStem(dir: string, stem: string, extensions: string[]): string {
  const occupied = (candidate: string): boolean =>
    extensions.some(ext => existsSync(join(dir, `${candidate}${ext}`)))
  if (!occupied(stem)) return stem
  let i = 1
  while (occupied(`${stem}_${i}`)) i++
  return `${stem}_${i}`
}
