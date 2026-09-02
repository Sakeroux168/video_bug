import type { VideoItem } from './adapters/types'
import type { Filters, DurationFilter, TimeRange } from '../shared/types'

export function matchTimeRange(tsSec: number, range: TimeRange, start?: string, end?: string, now: number = Date.now() / 1000): boolean {
  if (range === 'all') return true
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30
    return tsSec >= now - days * 86400
  }
  if (range === 'custom' && start && end) {
    const s = new Date(start + 'T00:00:00Z').getTime() / 1000
    const e = new Date(end + 'T23:59:59Z').getTime() / 1000
    return tsSec >= s && tsSec <= e
  }
  return true
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
