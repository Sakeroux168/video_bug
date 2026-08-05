import type { Filters } from '../../shared/types'
import type { PlatformAdapter, VideoItem } from './types'

/** 页面查找候选：css = 直接 querySelector（哈希类名是抖音发版变量，span.bR4uhU1W 已实测过期）；
 *  text = 文本精确匹配兜底；contains = 容器文本含关键词（面板场景，多词取覆盖最多、文本最短的最小容器） */
export type FilterCandidate =
  | { type: 'css'; sel: string }
  | { type: 'text'; text: string }
  | { type: 'contains'; contains: string[] }

/** 候选打点描述：css("span.bR4uhU1W") / 文字"筛选" / 文字含["排序依据","视频时长"] */
export function describeCandidate(c: FilterCandidate): string {
  if (c.type === 'css') return `css(${JSON.stringify(c.sel)})`
  if (c.type === 'text') return `文字${JSON.stringify(c.text)}`
  return `文字含${JSON.stringify(c.contains)}`
}

/** 筛选选项名映射表：组号 → (选项索引 → 面板显示文案)；索引即 data-index2，0=不限（不操作） */
export const FILTER_OPTION_NAMES: Record<number, Record<number, string>> = {
  1: { 0: '不限', 1: '一天内', 2: '一周内', 3: '半年内' }, // 发布时间
  2: { 0: '不限', 1: '1分钟以下', 2: '1-5分钟', 3: '5分钟以上' }, // 视频时长
  3: { 0: '不限', 1: '关注的人', 2: '最近看过', 3: '还未看过' }, // 搜索范围
  4: { 0: '不限', 1: '视频', 2: '图文' } // 内容形式
}

/** 筛选组显示名（打点用）：1发布时间/2时长/3搜索范围/4内容形式（组 0=排序，不操作） */
export const FILTER_GROUP_NAMES: Record<number, string> = {
  1: '发布时间', 2: '视频时长', 3: '搜索范围', 4: '内容形式'
}

/** 选项打点描述：组2(视频时长)选项2(1-5分钟) */
export function optionLabel(group: number, optionIndex: number): string {
  const name = FILTER_OPTION_NAMES[group]?.[optionIndex]
  return `组${group}(${FILTER_GROUP_NAMES[group] ?? '?'})选项${optionIndex}${name != null ? `(${name})` : ''}`
}

/** 抖音搜索筛选面板查找（多候选，哈希类名 → 文字/语义属性兜底，类名变动无需改代码）。
 *  组 data-index1：0排序/1发布时间/2时长/3搜索范围/4内容形式；选项 data-index2 即下拉索引（0=不限，不操作） */
export const FILTER_SELECTORS = {
  button: [
    { type: 'css', sel: 'span.bR4uhU1W' },
    { type: 'text', text: '筛选' }
  ] as FilterCandidate[],
  panel: [
    { type: 'css', sel: 'div.IMWRHJOg' },
    { type: 'contains', contains: ['排序依据', '视频时长'] }
  ] as FilterCandidate[],
  /** 底部文案正则：命中"滚到底"（抖音实测「暂时没有更多了」；覆盖"没有更多了"/"暂时没有更多"等变体） */
  bottomText: /没有更多|到底|暂时没有/i,
  /** 选项候选：语义属性 data-index1=组/data-index2=索引（非哈希，大概率稳定）优先；
   *  找不到时按选项名映射表在面板内文字匹配（兜底哈希过期场景） */
  option: (group: number, optionIndex: number): FilterCandidate[] => {
    const cands: FilterCandidate[] = [{ type: 'css', sel: `span[data-index1="${group}"][data-index2="${optionIndex}"]` }]
    const name = FILTER_OPTION_NAMES[group]?.[optionIndex]
    if (name != null) cands.push({ type: 'text', text: name })
    return cands
  }
}

/** 元素矩形（可见性校验用）：display:none/visibility:hidden 的常驻 DOM 元素宽高为 0 */
export interface RectLike {
  width: number
  height: number
}

/** 依次尝试候选，返回首个命中 { el, index }（全部未命中 el=null、index=-1）。
 *  纯函数、无 DOM 依赖：doc/textOf/scope 由调用方注入——浏览器侧经 resolveSelector.toString()
 *  嵌入页面脚本（doc=document、scope=已找到的面板元素，文字选项限定面板内查找），单测传 jsdom document。
 *  必须自包含：函数体内不得引用模块级常量（页面脚本无法解析外部作用域），标签列表内联。
 *  text 精确匹配（textOf 返回 trim 后文本，元素带子元素时取整体文本）；
 *  contains 在容器里选「命中关键词最多、文本最短」者——面板场景取包含关键词的最小公共容器，
 *  避免误命中过小的标签容器或整页容器。
 *  rectOf（可选）：注入元素矩形读取器（页面侧传 getBoundingClientRect 的宽高）做可见性校验——
 *  命中但宽高为 0（display:none/visibility:hidden，如 CSS :hover 驱动的常驻隐藏面板）视为未命中，
 *  继续尝试下一候选；全部候选命中但不可见时 el=null、index=最后一个被跳过的候选下标（-1 = 完全未命中），
 *  供打点区分「完全未命中」与「隐藏假命中」。不传 rectOf 时不做可见性过滤（兼容旧调用）。 */
export function resolveSelector(
  candidates: readonly FilterCandidate[],
  doc: { querySelector(sel: string): unknown; querySelectorAll(sel: string): unknown[] },
  textOf: (el: unknown) => string,
  scope: unknown,
  rectOf?: (el: unknown) => RectLike | null
): { el: unknown | null; index: number } {
  const root: { querySelector(sel: string): unknown; querySelectorAll(sel: string): unknown[] } =
    (scope as { querySelector(sel: string): unknown; querySelectorAll(sel: string): unknown[] } | null) ?? doc
  // 最后一个「命中但不可见」的候选下标（打点区分「完全未命中」与「隐藏面板假命中」）；-1 = 无
  let hiddenIndex = -1
  // 可见性校验通过才返回：无 rectOf 直接放行；宽高 0 记 hiddenIndex 并跳过
  const accept = (el: unknown, i: number): { el: unknown; index: number } | null => {
    if (!rectOf) return { el, index: i }
    const r = rectOf(el)
    if (r && r.width > 0 && r.height > 0) return { el, index: i }
    hiddenIndex = i
    return null
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (c.type === 'css') {
      let el: unknown = null
      try { el = root.querySelector(c.sel) } catch { /* 非法选择器忽略，走下一候选 */ }
      if (el) { const hit = accept(el, i); if (hit) return hit }
    } else if (c.type === 'text') {
      for (const el of root.querySelectorAll('span,button,div,a')) {
        if (textOf(el) === c.text) { const hit = accept(el, i); if (hit) return hit }
      }
    } else {
      let best: unknown = null
      let bestHits = -1
      let bestLen = Infinity
      for (const el of root.querySelectorAll('div,section,main')) {
        const t = textOf(el)
        const hits = c.contains.filter(k => t.includes(k)).length
        if (hits > 0 && (hits > bestHits || (hits === bestHits && t.length <= bestLen))) {
          best = el
          bestHits = hits
          bestLen = t.length
        }
      }
      if (best) { const hit = accept(best, i); if (hit) return hit }
    }
  }
  return { el: null, index: hiddenIndex }
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

/** 时长多候选解析（抖音接口为毫秒 → 取整秒）：顶层 duration → video.duration → 0。
 *  真实接口时长字段位置不定（可能在 video 下），做兜底；候选值为字符串数字也兼容（Number 转换）。 */
function pickDurationSec(o: Record<string, any>): number {
  const ms = Number(o.duration ?? (asObj(o.video).duration ?? 0))
  return Number.isFinite(ms) ? Math.round(ms / 1000) : 0
}

/** 0 时长诊断：解析出有效条目但时长多候选仍取不到（durationSec === 0）时，记录该条目顶层字段名，
 *  经 dy:raw 拦截日志展示，供实跑时对照真实接口字段位置 */
export interface DurationDiag {
  topKeys: string[]
}

// parseApiJson 同步暂存诊断，主进程 dy:raw 通道解析后经 drainDurationDiags 取走（只标记，不影响解析流程）
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
    durationSec,
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
  parseApiJson: (_url: string, json: unknown) => {
    const diags: DurationDiag[] = []
    const items = collectAwemeList(json)
      .map(a => parseAweme(a, diags))
      .filter((x): x is VideoItem => x !== null)
    durationDiags = diags // 暂存 0 时长诊断，供 dy:raw 通道取走
    return items
  },
  normalizePlayUrl
}
