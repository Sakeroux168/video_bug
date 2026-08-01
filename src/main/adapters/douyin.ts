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
  // 播放地址可能出现在多个字段：play_addr / play_url / play_addr_h264/265 / bit_rate[].play_addr
  const firstUrl = (obj: unknown): string => {
    const p = asObj(obj)
    return Array.isArray(p.url_list) && p.url_list.length > 0 ? String(p.url_list[0]) : ''
  }
  let playRaw = firstUrl(video.play_addr) || firstUrl(video.play_url)
    || firstUrl(video.play_addr_h264) || firstUrl(video.play_addr_265)
  if (!playRaw && Array.isArray(video.bit_rate)) {
    for (const br of video.bit_rate) {
      playRaw = firstUrl(asObj(br).play_addr)
      if (playRaw) break
    }
  }
  const stats = asObj(o.statistics)
  if (!id || !playRaw) return null
  return {
    awemeId: id,
    title: String(o.desc ?? ''),
    authorSecUid: secUid,
    authorNickname: nickname,
    authorHomeUrl: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    // 优先用原始地址（网页播放器即用它，通常已是无水印）；转换留作下载失败时的回退变体
    playUrl: playRaw,
    durationSec: Math.round(Number(o.duration ?? 0) / 1000),
    publishTime: Number(o.create_time ?? 0),
    likes: Number(stats.digg_count ?? 0)
  }
}

export function normalizePlayUrl(raw: string): string {
  // 仅做可靠的 playwm→play 替换（官方无水印直链手法）。
  // 不做 _watermark 字符串替换：实测该替换会把部分 CDN 文件名改坏，导致下载出黑屏视频。
  let url = raw
  if (url.includes('playwm')) url = url.replace('playwm', 'play')
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
