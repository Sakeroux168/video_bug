import type { PlatformAdapter, VideoItem } from './types'
import type { TaskType } from '../../shared/types'

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

function firstUrl(obj: unknown): string {
  const p = asObj(obj)
  return Array.isArray(p.url_list) && p.url_list.length > 0 ? String(p.url_list[0]) : ''
}

function positiveInteger(v: unknown): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

function nonNegativeIntegerOrNull(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function buildVideoUrl(workId: string): string {
  return `https://www.douyin.com/video/${encodeURIComponent(workId)}`
}

/** 时长多候选解析（抖音接口毫秒 → 精确秒数）：顶层 duration → video.duration → 0。
 *  真实接口时长字段位置不定（可能在 video 下），做兜底；候选值为字符串数字也兼容（Number 转换）。 */
function pickDurationSec(o: Record<string, any>): number {
  const ms = Number(o.duration ?? (asObj(o.video).duration ?? 0))
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0
}

/** 0 时长诊断：解析出有效条目但时长多候选仍取不到（durationSec === 0）时，记录该条目顶层字段名，
 *  经 platform:raw 拦截日志展示，供实跑时对照真实接口字段位置 */
export interface DurationDiag {
  topKeys: string[]
}

// parseApiJson 同步暂存诊断，主进程 platform:raw 通道解析后经 drainDurationDiags 取走（只标记，不影响解析流程）
let durationDiags: DurationDiag[] = []

export function drainDurationDiags(): DurationDiag[] {
  const out = durationDiags
  durationDiags = []
  return out
}

function parseAweme(a: unknown, diags: DurationDiag[]): VideoItem | null {
  const o = asObj(a)
  const id = String(o.aweme_id ?? '')
  const author = asObj(o.author)
  const secUid = String(author.sec_uid ?? '')
  const nickname = String(author.nickname ?? '')
  const video = asObj(o.video)
  // 播放地址可能出现在多个字段：play_addr / play_url / play_addr_h264/265 / bit_rate[].play_addr
  let playRaw = firstUrl(video.play_addr) || firstUrl(video.play_url)
    || firstUrl(video.play_addr_h264) || firstUrl(video.play_addr_265)
  if (!playRaw && Array.isArray(video.bit_rate)) {
    for (const br of video.bit_rate) {
      playRaw = firstUrl(asObj(br).play_addr)
      if (playRaw) break
    }
  }
  const stats = asObj(o.statistics)
  const durationSec = pickDurationSec(o)
  if (!id || !playRaw) return null
  // 0 时长诊断：该条目 id/playUrl 有效（真实视频），仅时长多候选仍取不到 → 记顶层字段名（只标记，不影响解析）
  if (durationSec === 0) diags.push({ topKeys: Object.keys(o) })
  return {
    awemeId: id,
    title: String(o.desc ?? ''),
    authorSecUid: secUid,
    authorNickname: nickname,
    authorHomeUrl: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    // 优先用原始地址（网页播放器即用它，通常已是无水印）；转换留作下载失败时的回退变体
    playUrl: playRaw,
    coverUrl: firstUrl(video.origin_cover) || firstUrl(video.cover) || firstUrl(video.dynamic_cover),
    width: positiveInteger(video.width),
    height: positiveInteger(video.height),
    durationSec,
    publishTime: Number(o.create_time ?? 0),
    likes: Number(stats.digg_count ?? 0),
    comments: nonNegativeIntegerOrNull(stats.comment_count),
    // 真机核对（2026-10-07）：statistics.collect_count / share_count；网页版 play_count 恒为 0，等于拿不到，不存
    collects: nonNegativeIntegerOrNull(stats.collect_count) ?? undefined,
    shares: nonNegativeIntegerOrNull(stats.share_count) ?? undefined,
    sourceUrl: buildVideoUrl(id)
  }
}

export function normalizePlayUrl(raw: string): string {
  // 仅做可靠的 playwm→play 替换（官方无水印直链手法）。
  // 不做 _watermark 字符串替换：实测该替换会把部分 CDN 文件名改坏，导致下载出黑屏视频。
  let url = raw
  if (url.includes('playwm')) url = url.replace('playwm', 'play')
  return url
}

// 完整抖音主页 URL：容忍 http(s)、www. 前缀、尾部 ?query / #hash / 尾斜杠（buildAuthorUrl 旁）
const AUTHOR_URL_RE = /^https?:\/\/(?:www\.|m\.)?douyin\.com\/user\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i
// 裸 sec_uid：无 scheme、无斜杠，字符集 [A-Za-z0-9_-]+
const BARE_SEC_UID_RE = /^[A-Za-z0-9_-]+$/

/** v.douyin.com 短链：明确不解析、不联网（无法在不发请求的情况下拿到跳转后的真实 sec_uid） */
export function isDouyinShortLink(raw: string): boolean {
  return /^https?:\/\/v\.douyin\.com\//i.test(raw.trim())
}

/** 解析用户粘贴的作者输入 → 归一化 sec_uid；短链/非本平台域名/空串/非法字符一律返回 null */
export function parseAuthorInput(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(AUTHOR_URL_RE)
  if (m) return m[1]
  if (BARE_SEC_UID_RE.test(s)) return s
  return null
}

/** 任务类型 ↔ 接口路径。规则由 scheduler.matchesTaskEndpoint() 原样搬来，逐条未改：
 *  keyword→/search/、author→/aweme/post/、hashtag→/challenge/ 或 /search/（话题页实走搜索接口）。
 *  抖音同一路径不会混装两种任务的数据，因此只看 URL，不看响应体。 */
export function matchesTaskResponse(type: TaskType, url: string): boolean {
  switch (type) {
    case 'keyword': return /\/search\//.test(url) // 关键词搜索（宽匹配）
    case 'author': return /\/aweme\/post\//.test(url) // 作者主页视频列表
    case 'hashtag': return /\/challenge\//.test(url) || /\/search\//.test(url)
    default: return false
  }
}

export const douyinAdapter: PlatformAdapter = {
  name: 'douyin',
  displayName: '抖音',
  taskReady: true,
  interactions: ['collects', 'shares'],
  sourceHosts: ['www.douyin.com'],
  sessionPartition: 'persist:douyin',
  homeUrl: 'https://www.douyin.com/',
  authorInputPlaceholder: 'https://www.douyin.com/user/xxx',
  downloadReferer: 'https://www.douyin.com/',
  apiUrlPatterns: [/aweme\/v1\/web\//, /aweme\/v1\/app\//],
  // 与泛化前写死在注入脚本里的两条特征逐字一致，不收窄
  rawUrlHints: ['/aweme/', '/search/'],
  buildSearchUrl: (q: string) => `https://www.douyin.com/search/${encodeURIComponent(q)}`,
  buildAuthorUrl: (secUid: string) => `https://www.douyin.com/user/${secUid}`,
  buildHashtagUrl: (q: string) => `https://www.douyin.com/search/%23${encodeURIComponent(q)}`,
  buildVideoUrl,
  parseAuthorInput,
  isShortLink: isDouyinShortLink,
  matchesTaskResponse: (type: TaskType, url: string) => matchesTaskResponse(type, url),
  parseApiJson: (_url: string, json: unknown) => {
    const diags: DurationDiag[] = []
    const items = collectAwemeList(json)
      .map(a => parseAweme(a, diags))
      .filter((x): x is VideoItem => x !== null)
    durationDiags = diags // 暂存 0 时长诊断，供 platform:raw 通道取走
    return items
  },
  normalizePlayUrl
}
