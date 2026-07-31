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

export function matchDuration(durSec: number, d: DurationFilter): boolean {
  if (d === 'all') return true
  if (d === 'short') return durSec < 60
  if (d === 'medium') return durSec >= 60 && durSec <= 300
  return durSec > 300
}

export function filterVideos(items: VideoItem[], filters: Filters, now: number = Date.now() / 1000): VideoItem[] {
  return items.filter(i =>
    matchTimeRange(i.publishTime, filters.timeRange, filters.startDate, filters.endDate, now) &&
    matchDuration(i.durationSec, filters.duration)
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
