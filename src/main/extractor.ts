import type { VideoItem } from './adapters/types'
import type { Filters, DurationFilter, TimeRange } from '../shared/types'

export function matchTimeRange(tsSec: number, range: TimeRange, start?: string, end?: string, now: number = Date.now() / 1000): boolean {
  if (range === 'all') return true
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30
    return tsSec >= now - days * 86400
  }
  if (range === 'custom') {
    // 日期按中国时间（UTC+8）算整天：用户选「3 月 10 日」指的是北京时间那一天，
    // 以前按 UTC 算会差 8 小时（当天早上 8 点前发的被算到前一天）。起止任一可以不填。
    const s = start ? chinaDayStartSec(start) : null
    const e = end ? chinaDayEndSec(end) : null
    if (s !== null && tsSec < s) return false
    if (e !== null && tsSec > e) return false
    return true
  }
  return true
}

/** 中国时区偏移：固定 +08:00，不看这台电脑设的是什么时区（员工电脑时区设错也不影响）。 */
const CHINA_OFFSET_SEC = 8 * 3600
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD 这一天北京时间 00:00:00 的秒级时间戳；格式不对返回 null（当没填） */
export function chinaDayStartSec(date: string): number | null {
  if (!DATE_RE.test(date)) return null
  const ms = new Date(date + 'T00:00:00+08:00').getTime()
  return Number.isFinite(ms) ? ms / 1000 : null
}

/** YYYY-MM-DD 这一天北京时间 23:59:59 的秒级时间戳；格式不对返回 null（当没填） */
export function chinaDayEndSec(date: string): number | null {
  const s = chinaDayStartSec(date)
  return s === null ? null : s + 86400 - 1
}

/** 北京时间的「今天」，YYYY-MM-DD */
export function chinaToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + CHINA_OFFSET_SEC * 1000).toISOString().slice(0, 10)
}

export function matchDuration(durSec: number, d: DurationFilter, minSec?: number, maxSec?: number): boolean {
  if (d === 'all') return true
  if (d === 'under30') return durSec > 0 && durSec <= 30
  if (d === 'custom') {
    if (!Number.isInteger(minSec) || !Number.isInteger(maxSec) || minSec! < 1 || maxSec! < minSec!) return false
    return durSec >= minSec! && durSec <= maxSec!
  }
  if (d === 'short') return durSec < 60
  if (d === 'medium') return durSec >= 60 && durSec <= 300
  return durSec > 300
}

export function filterVideos(items: VideoItem[], filters: Filters, now: number = Date.now() / 1000): VideoItem[] {
  return items.filter(i =>
    matchTimeRange(i.publishTime, filters.timeRange, filters.startDate, filters.endDate, now) &&
    matchDuration(i.durationSec, filters.duration, filters.durationMinSec, filters.durationMaxSec)
  )
}

export function dedupeVideos(items: VideoItem[], seen: Set<string>): VideoItem[] {
  const out: VideoItem[] = []
  for (const it of items) {
    if (seen.has(it.awemeId)) continue
    seen.add(it.awemeId)
    out.push(it)
  }
  return out
}

/** 从视频标题/文案里提取第一个 #话题 作为品类（#6），无则 null */
export function extractCategory(title: string): string | null {
  const m = title.match(/#([^\s#，。,.!！?？、]+)/)
  if (!m) return null
  const c = m[1].trim()
  return c.length > 0 && c.length <= 20 ? c : (c.length > 20 ? c.slice(0, 20) : null)
}
