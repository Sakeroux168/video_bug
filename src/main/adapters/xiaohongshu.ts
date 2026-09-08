import type { PlatformAdapter, VideoItem } from './types'
import type { TaskType } from '../../shared/types'

/**
 * 小红书适配器 —— 第 1 步：骨架，解析器尚未实现。
 *
 * 为什么先建骨架不写解析器：快手那一轮照公开资料把整个解析器写完（GraphQL 的
 * visionSearchPhoto / videoResource / photoUrl），真机一跑发现平台早就换成了
 * REST 的 /rest/v/search/feed，两处各断一次，等于白写。
 *
 * 所以这次倒过来：先让内置浏览器能打开小红书、能扫码登录、能把请求记进拦截日志
 * （日志对未命中的请求也会记 URL），拿到真实接口与响应结构之后再写解析。
 *
 * taskReady=false 是为了避免「半成品暴露」：平台出现在建任务下拉框、用户选了却
 * 跑不通。建任务一侧会明确拒绝并说明原因；内置浏览器一侧照常可用（登录必需）。
 */

// 完整主页 URL：https://www.xiaohongshu.com/user/profile/{userId}
// 这是页面地址形态（用户在浏览器里看得见的那种），不是接口地址；接口待真机抓取。
const AUTHOR_URL_RE = /^https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/([A-Za-z0-9]+)(?:[/?#].*)?$/i
const BARE_USER_ID_RE = /^[A-Za-z0-9]+$/

/** xhslink.com 短链：不联网解析，也不猜后面的真实 ID */
export function isXiaohongshuShortLink(raw: string): boolean {
  return /^https?:\/\/(?:www\.)?xhslink\.com\//i.test(raw.trim())
}

export function parseXiaohongshuAuthorInput(raw: string): string | null {
  const input = raw.trim()
  if (!input || isXiaohongshuShortLink(input)) return null
  const match = input.match(AUTHOR_URL_RE)
  if (match) return match[1]
  return BARE_USER_ID_RE.test(input) ? input : null
}

export const xiaohongshuAdapter: PlatformAdapter = {
  name: 'xiaohongshu',
  displayName: '小红书',
  // 解析器未实现：不能让它出现在建任务下拉框里
  taskReady: false,
  sourceHosts: ['www.xiaohongshu.com'],
  sessionPartition: 'persist:xiaohongshu',
  homeUrl: 'https://www.xiaohongshu.com/',
  authorInputPlaceholder: 'https://www.xiaohongshu.com/user/profile/xxx',
  downloadReferer: 'https://www.xiaohongshu.com/',

  // 接口地址待真机抓取。这里刻意留空：留空时所有请求在拦截日志里标「忽略」，
  // 但日志仍会记下 URL —— 快手的 /rest/v/search/feed 就是这么找到的。
  apiUrlPatterns: [],
  // content-type 不标准时的兜底特征。范围放宽一点，抓包阶段宁可多记。
  rawUrlHints: ['/api/', 'xiaohongshu.com'],

  // 以下三个是页面地址形态（浏览器地址栏里那种），非接口地址。
  // 未经真机验证，接入解析器时要一并核对。
  buildSearchUrl: (query: string) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
  buildAuthorUrl: (userId: string) => `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`,
  buildHashtagUrl: (query: string) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(`#${query}`)}`,
  buildVideoUrl: (noteId: string) => `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`,

  parseAuthorInput: parseXiaohongshuAuthorInput,
  isShortLink: isXiaohongshuShortLink,

  // 解析器未实现，明说未实现：不匹配任何任务、不产出任何条目。
  // 绝不写「先按公开资料猜一版」——快手已经证明那样只会白写并误导后来者。
  matchesTaskResponse: (_type: TaskType, _url: string, _json: unknown) => false,
  parseApiJson: (_url: string, _json: unknown): VideoItem[] => [],

  normalizePlayUrl: (rawUrl: string) => rawUrl
}
