import type { Filters } from '../../shared/types'
import type { PlatformAdapter, VideoItem } from './types'

/** 抖音搜索筛选面板选择器（哈希类名，有变动风险；平台迁移/类名变动只需改这里）。
 *  组 data-index1：0排序/1发布时间/2时长/3搜索范围/4内容形式；选项 data-index2 即下拉索引（0=不限，不操作） */
export const FILTER_SELECTORS = {
  button: 'span.bR4uhU1W',
  panel: 'div.IMWRHJOg',
  /** 底部文案正则：命中"滚到底"（抖音实测「暂时没有更多了」；覆盖"没有更多了"/"暂时没有更多"等变体） */
  bottomText: /没有更多|到底|暂时没有/i,
  option: (group: number, optionIndex: number): string =>
    `span[data-index1="${group}"][data-index2="${optionIndex}"]`
}

/** 是否"长得像"一条抖音视频对象（新版卡片有 aweme_info 包装；老版直接带 aweme_id+video/desc/author） */
function isAwemeLike(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if ('aweme_info' in o) return true // 新版 general/search 卡片
  return 'aweme_id' in o && ('video' in o || 'desc' in o || 'author' in o)
}

/** 深度收集视频对象：不依赖具体键名（老接口用 aweme_list，新版 general/search 是 data[] 卡片，视频在 aweme_info 里）。
 *  命中"包含视频对象的数组"即收下这些对象（新版解包 aweme_info），否则继续下钻。 */
export function collectAwemeList(json: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 10 || v == null) return
    if (Array.isArray(v)) {
      const awemes = v.filter(isAwemeLike)
      if (awemes.length > 0) {
        for (const a of awemes) out.push((a as Record<string, unknown>).aweme_info ?? a)
      } else {
        v.forEach(x => walk(x, depth + 1))
      }
      return
    }
    if (typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val, depth + 1)
    }
  }
  walk(json, 0)
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
