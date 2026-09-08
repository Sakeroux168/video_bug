import type { PlatformAdapter, VideoItem } from './types'
import type { TaskType } from '../../shared/types'

/**
 * 小红书适配器。
 *
 * 全部接口与结构来自 2026-09-08 用户本机的拦截日志与响应抓取，不采信公开资料——
 * 快手那一轮照公开资料写完解析器，真机一跑发现平台早换了传输方式，等于白写。
 *
 * 与抖音/快手的根本差异：搜索列表**只给卡片**（标题、封面、作者、互动数），
 * 没有播放地址、没有时长。播放地址只存在于笔记详情（/api/sns/web/v1/feed）里，
 * 而详情要 xsec_token + Cookie 签名，我们不生成也不代发，只能导航到笔记页让页面
 * 自己请求。所以列表阶段只产出「笔记存根」，由调度器逐条导航取详情后再入库。
 *
 * taskReady 在详情阶段接通前保持 false：平台能在内置浏览器里打开（登录、抓包），
 * 但不进建任务下拉框，避免「能选却跑不通」的半成品。
 */

type Obj = Record<string, unknown>

function asObj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

/** 互动数是字符串："57914"、"1.2万"、"3千"；空串是未知，不是 0。 */
export function parseXiaohongshuCount(value: unknown): number | null {
  const raw = text(value).replace(/,/g, '')
  if (!raw) return null
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([万wW千kK])?$/)
  if (!m) return null
  const unit = m[2]
  const mul = !unit ? 1 : /[万wW]/.test(unit) ? 10000 : 1000
  const n = Number(m[1]) * mul
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

// ---------------------------------------------------------------------------
// 页面地址（浏览器地址栏里那种）。搜索页实测：
//   https://www.xiaohongshu.com/search_result_ai?keyword=%25E7%25BE%258E%25E9%25A3%259F&source=unknown
// 路径是 search_result_ai；keyword 是二次编码（%25E7 解一次才是 %E7）。照实测形态拼。
// 作者主页与笔记页的地址形态尚未取证，接作者任务/详情阶段时要核对。
// ---------------------------------------------------------------------------
function buildSearchPage(query: string): string {
  return `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(encodeURIComponent(query))}&source=unknown`
}

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

// ---------------------------------------------------------------------------
// 搜索接口：so.xiaohongshu.com/api/sns/web/v2/search/notes
// 日志里是协议相对形态（//so.xiaohongshu.com/...），只按路径匹配，不要求 scheme。
// 响应根：{ code, success, msg, data: { items: [...], has_more } }
// ---------------------------------------------------------------------------
const SEARCH_API_RE = /\/api\/sns\/web\/v2\/search\/notes(?:[/?#]|$)/i

function isSearchResponse(url: string, json: unknown): boolean {
  if (!SEARCH_API_RE.test(url)) return false
  return Array.isArray(asObj(asObj(json).data).items)
}

/**
 * 笔记存根：列表阶段能拿到的全部信息。播放地址、时长、精确发布时间在详情里。
 * xsecToken 是一次性短期令牌，只在同一次任务的内存里用掉，不落库。
 */
export interface NoteStub {
  noteId: string
  xsecToken: string
  title: string
  authorId: string
  authorNickname: string
  coverUrl: string
  likes: number | null
  comments: number | null
}

export interface NoteStubResult {
  stubs: NoteStub[]
  /** 跳过计数，供拦截日志诊断：image = 图文笔记，other = 推荐词等非笔记条目 */
  skipped: { image: number; other: number }
}

function coverOf(card: Obj): string {
  const cover = asObj(card.cover)
  const direct = text(cover.url_default) || text(cover.url_pre)
  if (direct) return direct
  const first = asObj((card.image_list as unknown[] | undefined)?.[0])
  const info = asObj((first.info_list as unknown[] | undefined)?.[0])
  return text(info.url)
}

/**
 * 从搜索响应里取出视频笔记存根。
 * 只收 note_card.type === 'video'：实测不加筛选时 20 条里只有 1 条是视频，
 * 图文必须在这里丢掉并计数，「只看视频」筛选写不进网址、页面重开就丢。
 */
export function parseXiaohongshuNoteStubs(json: unknown): NoteStubResult {
  const result: NoteStubResult = { stubs: [], skipped: { image: 0, other: 0 } }
  const items = asObj(asObj(json).data).items
  if (!Array.isArray(items)) return result
  for (const raw of items) {
    const item = asObj(raw)
    if (text(item.model_type) !== 'note') { result.skipped.other++; continue }   // hot_query 等推荐位
    const card = asObj(item.note_card)
    if (text(card.type) !== 'video') { result.skipped.image++; continue }
    const noteId = text(item.id)
    const xsecToken = text(item.xsec_token)
    // 没有 token 进不了详情页，没有 id 无从去重；两者缺一整条丢弃
    if (!noteId || !xsecToken) { result.skipped.other++; continue }
    const user = asObj(card.user)
    const interact = asObj(card.interact_info)
    result.stubs.push({
      noteId,
      xsecToken,
      title: text(card.display_title),
      authorId: text(user.user_id),
      authorNickname: text(user.nickname) || text(user.nick_name),
      coverUrl: coverOf(card),
      likes: parseXiaohongshuCount(interact.liked_count),
      comments: parseXiaohongshuCount(interact.comment_count)
    })
  }
  return result
}

export const xiaohongshuAdapter: PlatformAdapter = {
  name: 'xiaohongshu',
  displayName: '小红书',
  // 详情阶段接通前不能进建任务下拉框
  taskReady: false,
  sourceHosts: ['www.xiaohongshu.com'],
  sessionPartition: 'persist:xiaohongshu',
  homeUrl: 'https://www.xiaohongshu.com/',
  authorInputPlaceholder: 'https://www.xiaohongshu.com/user/profile/xxx',
  downloadReferer: 'https://www.xiaohongshu.com/',

  apiUrlPatterns: [SEARCH_API_RE],
  // content-type 不标准时的兜底特征
  rawUrlHints: ['/api/sns/web/'],

  buildSearchUrl: (query: string) => buildSearchPage(query),
  buildHashtagUrl: (query: string) => buildSearchPage(`#${query}`),
  // 以下两个是页面地址形态，未经真机验证
  buildAuthorUrl: (userId: string) => `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`,
  buildVideoUrl: (noteId: string) => `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`,

  parseAuthorInput: parseXiaohongshuAuthorInput,
  isShortLink: isXiaohongshuShortLink,

  matchesTaskResponse: (type: TaskType, url: string, json: unknown) => {
    if (type === 'keyword' || type === 'hashtag') return isSearchResponse(url, json)
    return false // 作者主页接口未取证，不推测
  },

  // 列表没有播放地址，不能伪造成可下载的 VideoItem。
  // 完整条目由调度器在详情阶段组装（任务 2/3），这里保持为空。
  parseApiJson: (_url: string, _json: unknown): VideoItem[] => [],

  normalizePlayUrl: (rawUrl: string) => rawUrl
}
