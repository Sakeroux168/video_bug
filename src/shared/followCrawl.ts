import type { AuthorRow, CreateTaskInput } from './types'

/**
 * 爬作者主页的任务参数（作者收藏页的单个 / 批量爬，和 2026-10-07 定时追更共用）。
 * 原来写在 AuthorCollection.tsx 里，挪到 shared 让主进程的定时追更也用同一套规则。
 */

/** ISO 时间 → 北京时间日期 YYYY-MM-DD（作者主页日期段按北京时间算，与 R20 一致）；空或坏值返回 '' */
export function beijingDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
}

/** 真正「爬过主页」的博主才有「只抓新视频」：起点 = 库里最新视频的发布日；没有视频就用上次爬主页那天。
 *  关键词搜索时顺带收进作者库的博主库里可能只有一条视频，拿它当起点会让他以前的作品永远抓不到，所以不算爬过。 */
export function followFrom(a: AuthorRow): string {
  return beijingDate(a.latest_video_at) || beijingDate(a.last_crawled_at)
}
export const crawledBefore = (a: AuthorRow): boolean => Boolean(a.last_crawled_at)

export type CrawlScope = 'new' | 'all'

/** 单个 / 批量爬主页共用：按「只抓新视频 / 全部」算出任务参数。
 *  爬过的博主无论哪种都要允许重复——以前「已爬过」会直接拦掉，用户以为任务建好了（体验测试 老陈 🔴1）。 */
export function crawlRequest(a: AuthorRow, scope: CrawlScope, targetCount: number, autoDownload: boolean, forceDuplicate = false): CreateTaskInput {
  const base = { platform: a.platform, type: 'author' as const, query: a.sec_uid, aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload }
  const from = followFrom(a)
  if (scope === 'new' && crawledBefore(a) && from) {
    return { ...base, allowDuplicateAuthor: true, filters: { timeRange: 'custom', startDate: from, duration: 'all', targetCount } }
  }
  return {
    ...base,
    ...(forceDuplicate || crawledBefore(a) ? { allowDuplicateAuthor: true } : {}),
    filters: { timeRange: 'all', duration: 'all', targetCount }
  }
}
