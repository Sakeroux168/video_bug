import type { PlatformAdapter, VideoItem, ListStub, ListStubResult, FastDetailOutcome } from './types'
import type { Filters, TaskType } from '../../shared/types'

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
 * 关键词、话题与作者任务都走两段式。作者主页的 user_posted 接口不含详情令牌，
 * 令牌实际位于渲染后的作品卡片链接里，因此作者列表从 DOM 卡片收集视频候选。
 */

type Obj = Record<string, unknown>

function asObj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function positiveNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
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
// 笔记页于 2026-09-28 按用户提供的搜索笔记链接核对；作者卡片链接同日真机核对。
// ---------------------------------------------------------------------------
function buildSearchPage(query: string): string {
  return `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(encodeURIComponent(query))}&source=unknown`
}

function buildAuthorPage(userId: string): string {
  return `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`
}

/** 作品页地址。不带 xsec_token：那是一次性短期令牌，不能当永久身份存库。 */
function buildNotePage(noteId: string): string {
  return `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`
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
// 接口。日志里都是协议相对形态（//so.xiaohongshu.com/...），只按路径匹配，不要求 scheme。
//   搜索：so.xiaohongshu.com/api/sns/web/v2/search/notes   根 { code, success, msg, data: { items, has_more } }
//   详情：edith.xiaohongshu.com/api/sns/web/v1/feed        根 { code, success, msg, data: { items, cursor_score, current_time } }
// ---------------------------------------------------------------------------
const SEARCH_API_RE = /\/api\/sns\/web\/v2\/search\/notes(?:[/?#]|$)/i
const DETAIL_API_RE = /\/api\/sns\/web\/v1\/feed(?:[/?#]|$)/i

function itemsOf(json: unknown): unknown[] | null {
  const items = asObj(asObj(json).data).items
  return Array.isArray(items) ? items : null
}

function isSearchResponse(url: string, json: unknown): boolean {
  return SEARCH_API_RE.test(url) && itemsOf(json) !== null
}

/** 详情响应判定：调度器在详情阶段用它认出"这是我刚导航过去那条笔记的详情"。 */
export function isXiaohongshuDetailResponse(url: string, json: unknown, noteId?: string): boolean {
  const items = itemsOf(json)
  return DETAIL_API_RE.test(url) && items !== null && (noteId === undefined || items.some(raw => {
    const item = asObj(raw)
    return (text(asObj(item.note_card).note_id) || text(item.id)) === noteId
  }))
}

// ---------------------------------------------------------------------------
// 列表：笔记存根
// ---------------------------------------------------------------------------

/**
 * 笔记存根：列表阶段能拿到的全部信息。播放地址、时长、精确发布时间在详情里。
 * detailToken 是短期令牌，只在同一次任务的内存里用掉，不落库。
 */
export type NoteStub = ListStub

export type NoteStubResult = ListStubResult

/** 列表卡片与详情的封面都藏在同一种结构里：先 url_default / url_pre，再 image_list[0].info_list[0].url */
function coverOf(card: Obj): string {
  const cover = asObj(card.cover)
  const direct = text(cover.url_default) || text(cover.urlDefault) || text(cover.url_pre) || text(cover.urlPre)
  if (direct) return direct
  const images = (card.image_list ?? card.imageList) as unknown[] | undefined
  const first = asObj(images?.[0])
  const fromFirst = text(first.url_default) || text(first.urlDefault) || text(first.url_pre) || text(first.urlPre)
  if (fromFirst) return fromFirst
  const infos = (first.info_list ?? first.infoList) as unknown[] | undefined
  const info = asObj(infos?.[0])
  return text(info.url)
}

/**
 * 从搜索响应里取出视频笔记存根。
 * 只收 note_card.type === 'video'：实测不加筛选时 20 条里只有 1 条是视频，
 * 图文仍必须在这里做最终兜底丢弃；网页原生“视频”筛选只用于减少无效候选。
 */
export function parseXiaohongshuNoteStubs(json: unknown): NoteStubResult {
  const result: NoteStubResult = { stubs: [], skipped: { image: 0, other: 0 } }
  const items = itemsOf(json)
  if (!items) return result
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
      detailToken: xsecToken,
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

/**
 * 作者主页的 /user_posted 响应不带详情 xsec_token；页面把令牌放在每张卡片的 href。
 * 只认带 data-note-id、play-icon 和 pc_user 详情链接的卡片，避免把图文笔记送进详情阶段。
 */
export function buildXiaohongshuAuthorListDomScript(): string {
  return `(() => {
    const out = [];
    for (const card of document.querySelectorAll('.note-item[data-note-id]')) {
      const noteId = (card.getAttribute('data-note-id') || '').trim();
      if (!noteId || !card.querySelector('.play-icon')) continue;
      const links = [...card.querySelectorAll('a[href*="xsec_token="]')];
      const link = links.find(a => {
        try {
          const u = new URL(a.getAttribute('href') || '', location.href);
          return u.hostname === 'www.xiaohongshu.com'
            && u.pathname.includes('/user/profile/')
            && u.pathname.endsWith('/' + noteId)
            && u.searchParams.get('xsec_token');
        } catch (e) { return false; }
      });
      if (!link) continue;
      const u = new URL(link.getAttribute('href') || '', location.href);
      const title = card.querySelector('.title span, .title')?.textContent || '';
      const cover = card.querySelector('a.cover img');
      const count = card.querySelector('.count')?.textContent || '';
      out.push({
        noteId,
        detailToken: u.searchParams.get('xsec_token') || '',
        detailSource: u.searchParams.get('xsec_source') || 'pc_user',
        detailUrl: u.href,
        authorId: (u.pathname.match(/\\/user\\/profile\\/([^/]+)\\//) || [])[1] || '',
        title: title.trim(),
        coverUrl: cover ? (cover.getAttribute('src') || '') : '',
        likesText: count.trim()
      });
    }
    return out;
  })()`
}

export function parseXiaohongshuAuthorDomResult(value: unknown): ListStubResult {
  const result: ListStubResult = { stubs: [], skipped: { image: 0, other: 0 } }
  if (!Array.isArray(value)) return result
  for (const raw of value) {
    const item = asObj(raw)
    const noteId = text(item.noteId)
    const token = text(item.detailToken)
    const source = text(item.detailSource) || 'pc_user'
    const authorId = text(item.authorId)
    let detailUrl = ''
    try {
      const u = new URL(text(item.detailUrl))
      const expectedPath = `/user/profile/${authorId}/${noteId}`
      if (u.protocol === 'https:' && u.hostname === 'www.xiaohongshu.com'
        && u.pathname === expectedPath && u.searchParams.get('xsec_token') === token) {
        detailUrl = u.href
      }
    } catch { /* malformed DOM value */ }
    if (!noteId || !token || !authorId || !detailUrl) { result.skipped.other++; continue }
    result.stubs.push({
      noteId,
      detailToken: token,
      detailSource: source,
      detailUrl,
      title: text(item.title),
      authorId,
      authorNickname: '',
      coverUrl: text(item.coverUrl),
      likes: parseXiaohongshuCount(item.likesText),
      comments: null
    })
  }
  return result
}

export function xiaohongshuNativeSearchFilters(type: TaskType, filters: Filters) {
  if (type === 'author') return []
  const out = [{ group: '笔记类型', option: '视频' }]
  // 站点没有“近30天”或自定义日期；这些情况只在详情阶段按时间戳精确过滤。
  if (filters.timeRange === '7d') out.push({ group: '发布时间', option: '一周内' })
  return out
}

// ---------------------------------------------------------------------------
// 详情：完整条目
// ---------------------------------------------------------------------------

interface StreamCandidate {
  url: string
  width: number
  height: number
  bitrate: number
  durationMs: number
  /** 'EF4' | 'EF5' 等，小红书自有编码标识，含义未取证 */
  codec: string
}

/** 播放地址容器：正常在 video.media；缺失时 video.media_v2 是同一份数据的 JSON 字符串副本 */
function mediaOf(video: Obj): Obj {
  const media = asObj(video.media)
  if (Object.keys(media).length > 0) return media
  const raw = video.media_v2 ?? video.mediaV2
  if (typeof raw !== 'string') return {}
  try { return asObj(JSON.parse(raw)) } catch { return {} }
}

function collectStreams(media: Obj): StreamCandidate[] {
  const out: StreamCandidate[] = []
  const groups = asObj(media.stream)
  for (const [group, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const s = asObj(raw)
      // master_url 带签名与时效；backup_urls 无签名，作回退
      const backupValue = s.backup_urls ?? s.backupUrls
      const backups = Array.isArray(backupValue) ? backupValue.map(text).filter(Boolean) : []
      const url = text(s.master_url) || text(s.masterUrl) || backups[0] || ''
      if (!url) continue
      out.push({
        url,
        width: positiveNumber(s.width),
        height: positiveNumber(s.height),
        bitrate: positiveNumber(s.avg_bitrate) || positiveNumber(s.avgBitrate)
          || positiveNumber(s.video_bitrate) || positiveNumber(s.videoBitrate),
        durationMs: positiveNumber(s.duration),
        codec: text(s.video_codec) || text(s.videoCodec) || group
      })
    }
  }
  return out
}

/**
 * 清晰度选择。转码目标是 1080×1920，再高的档位是白花流量与转码时间
 * （实测 2160p 单文件 212 MB）。所以：
 *   1. 短边 ≤1080 的里面取最大
 *   2. 全都高于 1080 时取最小的那档
 *   3. 同分辨率优先 EF4：编码含义未取证，EF4 只有低档位、更像基础编码，更保守
 *   4. 再同则取码率高的
 */
function pickStream(candidates: StreamCandidate[]): StreamCandidate | null {
  if (candidates.length === 0) return null
  const shortSide = (c: StreamCandidate): number => Math.min(c.width, c.height)
  const tieBreak = (a: StreamCandidate, b: StreamCandidate): number => {
    if (a.codec !== b.codec) return a.codec === 'EF4' ? -1 : b.codec === 'EF4' ? 1 : 0
    return b.bitrate - a.bitrate
  }
  const fits = candidates.filter(c => shortSide(c) <= 1080)
  if (fits.length > 0) {
    return [...fits].sort((a, b) => (shortSide(b) - shortSide(a)) || tieBreak(a, b))[0]
  }
  return [...candidates].sort((a, b) => (shortSide(a) - shortSide(b)) || tieBreak(a, b))[0]
}

/** 标题为空时用正文顶上：去掉 `#xxx[话题]#` 标记，收敛空白 */
function titleFromDesc(desc: string): string {
  return desc.replace(/#[^#\n]*?\[话题\]#/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 13 位毫秒 → 整秒；10 位秒保留；其余 0 */
function unixSeconds(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n > 1_000_000_000_000 ? n / 1000 : n)
}

/**
 * 从笔记详情响应组装完整条目。播放地址只有这里有。
 * 一档地址都取不到、或不是视频笔记 → null，不入库一个点不开的视频。
 */
export function parseXiaohongshuNoteDetail(json: unknown): VideoItem | null {
  const items = itemsOf(json)
  if (!items) return null
  const item = items.map(asObj).find(i => Object.keys(asObj(i.note_card)).length > 0)
  if (!item) return null
  const card = asObj(item.note_card)
  if (text(card.type) !== 'video') return null

  const noteId = text(card.note_id) || text(card.noteId) || text(item.id)
  const video = asObj(card.video)
  const media = mediaOf(video)
  const selected = pickStream(collectStreams(media))
  if (!noteId || !selected) return null

  const user = asObj(card.user)
  const interact = asObj(card.interact_info ?? card.interactInfo)
  const authorId = text(user.user_id) || text(user.userId)

  // 时长：capa.duration（秒）→ media.video.duration（秒）→ 所选档位的毫秒时长
  const durationSec = positiveNumber(asObj(video.capa).duration)
    || positiveNumber(asObj(media.video).duration)
    || (selected.durationMs > 0 ? selected.durationMs / 1000 : 0)

  return {
    awemeId: noteId,
    title: text(card.title) || titleFromDesc(text(card.desc)),
    authorSecUid: authorId,
    authorNickname: text(user.nickname) || text(user.nick_name) || text(user.nickName),
    authorHomeUrl: authorId ? buildAuthorPage(authorId) : '',
    playUrl: selected.url,
    coverUrl: coverOf(card),
    width: selected.width,
    height: selected.height,
    durationSec,
    publishTime: unixSeconds(card.time),
    likes: parseXiaohongshuCount(interact.liked_count ?? interact.likedCount) ?? 0,
    comments: parseXiaohongshuCount(interact.comment_count ?? interact.commentCount),
    sourceUrl: buildNotePage(noteId)
  }
}

/**
 * note（页面注水形态，字段驼峰）→ 与 /feed 响应同构的 {data:{items:[{id,note_card}]}}，
 * 之后统一走 parseXiaohongshuNoteDetail 的字段口径。
 * buildXiaohongshuDetailDomScript 在页面里按同一份口径生成同样的结构，两处必须保持一致；
 * 白名单字段本身就是脱敏：xsecToken 之类不会混进解析结果。
 */
export function noteToDetailPayload(noteId: string, note: Obj): unknown {
  const user = asObj(note.user)
  return { data: { items: [{ id: noteId, note_card: {
    noteId: note.noteId, type: note.type, title: note.title, desc: note.desc, time: note.time,
    user: { userId: user.userId, nickname: user.nickname, nickName: user.nickName },
    interactInfo: note.interactInfo,
    imageList: note.imageList,
    video: note.video
  } }] } }
}

/**
 * 2026-09-28 真机确认：直接打开详情页不会请求 /feed，页面把详情注水到
 * __INITIAL_STATE__.note.noteDetailMap[noteId].note。只返回解析所需字段，主动排除
 * 笔记与作者对象里的 xsecToken；currentNoteId 与 note.noteId 必须同时匹配。
 */
export function buildXiaohongshuDetailDomScript(noteId: string): string {
  return `(() => {
    const expected = ${JSON.stringify(noteId)};
    const unref = value => value && typeof value === 'object' && (value.__v_isRef || '_value' in value || 'value' in value)
      ? (value._value ?? value.value ?? value._rawValue) : value;
    const store = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.note;
    if (!store || String(unref(store.currentNoteId) || '') !== expected) return null;
    const detailMap = unref(store.noteDetailMap);
    const entry = detailMap && unref(detailMap[expected]);
    const note = entry && unref(entry.note);
    if (!note || String(unref(note.noteId) || '') !== expected) return null;
    const user = note.user || {};
    const result = { data: { items: [{ id: expected, note_card: {
      noteId: note.noteId, type: note.type, title: note.title, desc: note.desc, time: note.time,
      user: { userId: user.userId, nickname: user.nickname, nickName: user.nickName },
      interactInfo: note.interactInfo, imageList: note.imageList,
      video: note.video
    } }] } };
    return JSON.parse(JSON.stringify(result));
  })()`
}

// ---------------------------------------------------------------------------
// 快速模式：登录态 session 拉详情 HTML，解析 window.__INITIAL_STATE__。
// 这段状态不是标准 JSON（含 undefined、new Map([]) 等写法），先宽松清理再 JSON.parse。
// 日志安全：所有 skip 原因都是固定文案，不携带响应体片段；令牌只用于拼请求地址。
// ---------------------------------------------------------------------------

const LOGIN_PATH_RE = /\/login(?:[/?#]|$)/i
const VERIFY_HINT_RE = /验证码|安全验证|captcha|verify/i
const STATE_MARKER_RE = /window\.__INITIAL_STATE__\s*=\s*/

/** 从 HTML 里截取 __INITIAL_STATE__ 赋值表达式（到 </script> 为止，剥尾部分号） */
function extractInitialState(html: string): string | null {
  const m = STATE_MARKER_RE.exec(html)
  if (!m) return null
  const start = m.index + m[0].length
  const end = html.indexOf('</script>', start)
  const raw = (end < 0 ? html.slice(start) : html.slice(start, end)).trim()
  return raw.endsWith(';') ? raw.slice(0, -1) : raw
}

/**
 * 把 `new Map(...)` / `new Set(...)` 换成括号里的表达式（Map 摊平成 [键, 值] 对数组），
 * 再由调用方把 `undefined` 换成 null。构造器的实参里可能出现嵌套对象/数组/字符串，
 * 必须按括号配平扫描，不能用正则一把梭；扫描时跳过字符串字面量防止括号误配。
 */
function stripJsCtors(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src.startsWith('new', i)) {
      const m = /^new\s+(?:Map|Set)\s*\(/.exec(src.slice(i))
      if (m) {
        let depth = 0
        let quote: string | null = null
        let j = i + m[0].length - 1 // 指向 '('
        for (; j < src.length; j++) {
          const ch = src[j]
          if (quote) {
            if (ch === '\\') { j++; continue }
            if (ch === quote) quote = null
            continue
          }
          if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
          if (ch === '(' || ch === '[' || ch === '{') depth++
          else if (ch === ')' || ch === ']' || ch === '}') {
            depth--
            if (depth === 0) break
          }
        }
        out += src.slice(i + m[0].length, j) // 括号内的表达式，替换掉 new X(...) 本身
        i = j + 1
        continue
      }
    }
    const next = src.indexOf('new', i + 1)
    if (next < 0) { out += src.slice(i); break }
    out += src.slice(i, next)
    i = next
  }
  return out
}

/** 真机确认过 currentNoteId 会在注水后变成 Vue ref（{_rawValue,_value,...}），按同一套启发拆值 */
function unref(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const o = value as Obj
  return o.__v_isRef || '_value' in o || 'value' in o
    ? (o._value ?? o.value ?? o._rawValue)
    : value
}

/** noteDetailMap 可能是对象，也可能因 new Map 清理变成 [键, 值] 对数组，两种都认 */
function detailMapOf(raw: unknown): Record<string, unknown> {
  const v = unref(raw)
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (Array.isArray(v)) {
    const out: Record<string, unknown> = {}
    for (const pair of v) {
      if (Array.isArray(pair) && pair.length >= 1) out[String(pair[0])] = pair[1]
    }
    return out
  }
  return {}
}

/**
 * 快速模式入口：解析登录态拉回的详情页 HTML。复用 parseXiaohongshuNoteDetail 的
 * 字段口径（noteToDetailPayload 与 buildXiaohongshuDetailDomScript 同构）。
 */
export function parseXiaohongshuDetailHtml(finalUrl: string, html: string, noteId: string): FastDetailOutcome {
  let path = finalUrl
  try { path = new URL(finalUrl).pathname } catch { /* finalUrl 不是合法 URL 时按原文匹配 */ }
  if (LOGIN_PATH_RE.test(path)) return { kind: 'login' }
  const raw = extractInitialState(html)
  if (raw === null) {
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? ''
    if (VERIFY_HINT_RE.test(`${title} ${path}`)) return { kind: 'verify' }
    return { kind: 'skip', reason: '详情页没有注水状态，可能被风控拦截' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsCtors(raw).replace(/\bundefined\b/g, 'null'))
  } catch {
    return { kind: 'skip', reason: '注水状态宽松解析失败' }
  }
  const noteState = asObj(asObj(parsed).note)
  if (String(unref(noteState.currentNoteId) ?? '') !== noteId) {
    return { kind: 'skip', reason: '注水状态不属于当前笔记' }
  }
  const map = detailMapOf(noteState.noteDetailMap)
  const note = asObj(unref(asObj(unref(map[noteId])).note))
  if (String(unref(note.noteId) ?? '') !== noteId) {
    return { kind: 'skip', reason: '注水状态里找不到当前笔记的详情' }
  }
  const item = parseXiaohongshuNoteDetail(noteToDetailPayload(noteId, note))
  if (!item) return { kind: 'skip', reason: '详情解析失败或无视频地址' }
  return { kind: 'ok', item }
}

export const xiaohongshuAdapter: PlatformAdapter = {
  name: 'xiaohongshu',
  displayName: '小红书',
  taskReady: true,
  supportedTaskTypes: ['keyword', 'author', 'hashtag'],
  sourceHosts: ['www.xiaohongshu.com'],
  sessionPartition: 'persist:xiaohongshu',
  homeUrl: 'https://www.xiaohongshu.com/',
  authorInputPlaceholder: 'https://www.xiaohongshu.com/user/profile/xxx',
  downloadReferer: 'https://www.xiaohongshu.com/',

  apiUrlPatterns: [SEARCH_API_RE, DETAIL_API_RE],
  // content-type 不标准时的兜底特征
  rawUrlHints: ['/api/sns/web/'],

  buildSearchUrl: (query: string) => buildSearchPage(query),
  buildHashtagUrl: (query: string) => buildSearchPage(`#${query}`),
  buildAuthorUrl: buildAuthorPage,
  buildVideoUrl: buildNotePage,

  parseAuthorInput: parseXiaohongshuAuthorInput,
  isShortLink: isXiaohongshuShortLink,

  // 详情响应不属于任何任务类型的"列表"：用户手点笔记不能污染正在跑的任务。
  // 调度器在详情阶段单独用 isXiaohongshuDetailResponse 认领。
  matchesTaskResponse: (type: TaskType, url: string, json: unknown) => {
    if (type === 'keyword' || type === 'hashtag') return isSearchResponse(url, json)
    return false // 作者主页接口未取证，不推测
  },

  // 列表没有播放地址，不能伪造成可下载的 VideoItem。
  // 完整条目由调度器在详情阶段用 parseXiaohongshuNoteDetail 组装。
  parseApiJson: (_url: string, _json: unknown): VideoItem[] => [],

  parseListStubs: (_url, json) => ({
    ...parseXiaohongshuNoteStubs(json),
    hasMore: typeof asObj(asObj(json).data).has_more === 'boolean'
      ? asObj(asObj(json).data).has_more as boolean : undefined
  }),
  nativeSearchFilters: xiaohongshuNativeSearchFilters,
  buildListDomScript: type => type === 'author' ? buildXiaohongshuAuthorListDomScript() : null,
  parseListDomResult: parseXiaohongshuAuthorDomResult,
  // 2026-09-28 搜索详情与作者卡片地址均已核对；实际令牌仅在任务内存里使用。
  buildDetailUrl: stub => stub.detailUrl
    || `${buildNotePage(stub.noteId)}?xsec_token=${encodeURIComponent(stub.detailToken)}&xsec_source=${encodeURIComponent(stub.detailSource || 'pc_search')}`,
  buildDetailDomScript: buildXiaohongshuDetailDomScript,
  isDetailResponse: isXiaohongshuDetailResponse,
  parseDetail: parseXiaohongshuNoteDetail,
  parseDetailHtml: parseXiaohongshuDetailHtml,

  normalizePlayUrl: (rawUrl: string) => rawUrl
}
