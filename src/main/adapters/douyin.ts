import type { Filters } from '../../shared/types'
import type { PlatformAdapter, VideoItem } from './types'

/** 深度优先收集所有 aweme_list 数组（搜索/主页/话题响应结构各不相同） */
export function collectAwemeList(json: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'aweme_list' && Array.isArray(val)) out.push(...val)
        else walk(val)
      }
    }
  }
  walk(json)
  return out
}

function asObj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' ? (v as Record<string, any>) : {}
}

function parseAweme(a: unknown): VideoItem | null {
  const o = asObj(a)
  const id = String(o.aweme_id ?? '')
  const author = asObj(o.author)
  const secUid = String(author.sec_uid ?? '')
  const nickname = String(author.nickname ?? '')
  const video = asObj(o.video)
  const play = asObj(video.play_addr)
  const playRaw = Array.isArray(play.url_list) && play.url_list.length > 0 ? String(play.url_list[0]) : ''
  const stats = asObj(o.statistics)
  if (!id || !playRaw) return null
  return {
    awemeId: id,
    title: String(o.desc ?? ''),
    authorSecUid: secUid,
    authorNickname: nickname,
    authorHomeUrl: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    playUrl: normalizePlayUrl(playRaw),
    durationSec: Math.round(Number(o.duration ?? 0) / 1000),
    publishTime: Number(o.create_time ?? 0),
    likes: Number(stats.digg_count ?? 0)
  }
}

export function normalizePlayUrl(raw: string): string {
  let url = raw
  if (url.includes('playwm')) url = url.replace('playwm', 'play')
  if (url.includes('_watermark')) url = url.replace('_watermark', '')
  return url
}

export const douyinAdapter: PlatformAdapter = {
  name: 'douyin',
  displayName: '抖音',
  sessionPartition: 'persist:douyin',
  apiUrlPatterns: [/aweme\/v1\/web\//, /aweme\/v1\/app\//],
  buildSearchUrl: (q: string) => `https://www.douyin.com/search/${encodeURIComponent(q)}`,
  buildAuthorUrl: (secUid: string) => `https://www.douyin.com/user/${secUid}`,
  buildHashtagUrl: (q: string) => `https://www.douyin.com/search/%23${encodeURIComponent(q)}`,
  parseApiJson: (_url: string, json: unknown) =>
    collectAwemeList(json).map(parseAweme).filter((x): x is VideoItem => x !== null),
  normalizePlayUrl
}
