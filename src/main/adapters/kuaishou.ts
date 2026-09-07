import type { PlatformAdapter, VideoItem } from './types'
import type { TaskType } from '../../shared/types'

type Obj = Record<string, unknown>

interface PhotoContext {
  photo: Obj
  author: Obj
}

interface VideoCandidate {
  url: string
  width: number
  height: number
  bitrate: number
}

function asObj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function positiveInteger(value: unknown): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 0
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function count(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const raw = String(value).trim().replace(/,/g, '')
  if (!raw) return null
  const unit = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([万wW])$/)
  const n = unit ? Number(unit[1]) * 10000 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function parseResourceJson(resource: unknown): Obj {
  const container = asObj(resource)
  const raw = container.json ?? resource
  if (typeof raw === 'string') {
    try { return asObj(JSON.parse(raw)) } catch { return {} }
  }
  return asObj(raw)
}

function collectRepresentations(codec: unknown): VideoCandidate[] {
  const out: VideoCandidate[] = []
  const adaptationSet = asObj(codec).adaptationSet
  const sets = Array.isArray(adaptationSet) ? adaptationSet : [adaptationSet]
  for (const set of sets) {
    const representations = asObj(set).representation
    if (!Array.isArray(representations)) continue
    for (const raw of representations) {
      const rep = asObj(raw)
      const url = text(rep.url)
      if (!url) continue
      out.push({
        url,
        width: positiveInteger(rep.width),
        height: positiveInteger(rep.height),
        bitrate: Number(rep.maxBitrate ?? rep.avgBitrate ?? rep.bitrate ?? 0) || 0
      })
    }
  }
  return out.sort((a, b) => (b.bitrate - a.bitrate) || ((b.width * b.height) - (a.width * a.height)))
}

function pickRepresentation(photo: Obj): VideoCandidate | null {
  const resource = parseResourceJson(photo.videoResource)
  const h264 = collectRepresentations(resource.h264)
  if (h264.length > 0) return h264[0]
  const hevc = collectRepresentations(resource.hevc ?? resource.h265)
  return hevc[0] ?? null
}

function coverUrl(photo: Obj): string {
  const direct = text(photo.coverUrl)
  if (direct) return direct
  const covers = photo.coverUrls
  if (!Array.isArray(covers)) return ''
  for (const raw of covers) {
    const url = text(asObj(raw).url)
    if (url) return url
  }
  return ''
}

function looksLikePhoto(value: unknown): boolean {
  const photo = asObj(value)
  return !!text(photo.id) && (
    !!text(photo.photoUrl) ||
    Object.keys(asObj(photo.videoResource)).length > 0 ||
    'caption' in photo ||
    'originCaption' in photo
  )
}

/**
 * 收集 GraphQL 中的 Feed/详情容器，同时保留同级作者信息。
 * 不依赖 visionSearchPhoto 等根键名，接口只要继续返回 author + photo 契约即可解析。
 */
export function collectKuaishouPhotos(json: unknown): PhotoContext[] {
  const out: PhotoContext[] = []
  const seen = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value == null) return
    if (Array.isArray(value)) {
      value.forEach(item => walk(item, depth + 1))
      return
    }
    const obj = asObj(value)
    if (Object.keys(obj).length === 0) return
    const nestedPhoto = asObj(obj.photo)
    if (looksLikePhoto(nestedPhoto)) {
      const author = Object.keys(asObj(obj.author)).length > 0 ? asObj(obj.author) : asObj(nestedPhoto.author)
      const key = text(nestedPhoto.id)
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ photo: nestedPhoto, author })
      }
      return
    }
    if (looksLikePhoto(obj) && Object.keys(asObj(obj.author)).length > 0) {
      const key = text(obj.id)
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ photo: obj, author: asObj(obj.author) })
      }
      return
    }
    Object.values(obj).forEach(item => walk(item, depth + 1))
  }
  walk(json, 0)
  return out
}

function buildVideoUrl(workId: string): string {
  return `https://www.kuaishou.com/short-video/${encodeURIComponent(workId)}`
}

/** 关键词与话题都走搜索；话题在快手就是带 # 的搜索词，没有独立接口。 */
const SEARCH_OPERATIONS = ['visionSearchPhoto']
/** 作者主页作品列表。 */
const AUTHOR_OPERATIONS = ['visionProfilePhotoList']

/** 取响应里出现的 GraphQL operation 根字段名。
 *  正常是 { data: { visionSearchPhoto: ... } }；也兼容中间层已拆掉 data 包装的情形。 */
function responseOperations(json: unknown): string[] {
  const root = asObj(json)
  const data = asObj(root.data)
  return Object.keys(Object.keys(data).length > 0 ? data : root)
}

/** 快手所有业务共用 https://www.kuaishou.com/graphql，URL 区分不了任务类型，只能看 operation。
 *  白名单判定：visionVideoDetail（用户手点的详情）、推荐流等未知 operation 一律拒绝，
 *  不拿"能解析出视频"当放行理由——那会让无关响应污染正在跑的任务。 */
export function matchesKuaishouTaskResponse(type: TaskType, json: unknown): boolean {
  const operations = responseOperations(json)
  const wanted = type === 'author' ? AUTHOR_OPERATIONS
    : (type === 'keyword' || type === 'hashtag') ? SEARCH_OPERATIONS
    : []
  return wanted.some(op => operations.includes(op))
}

function parsePhoto(context: PhotoContext): VideoItem | null {
  const { photo, author } = context
  const id = text(photo.id)
  const authorId = text(author.id ?? author.userId ?? author.user_id)
  const selected = pickRepresentation(photo)
  const playUrl = text(photo.photoUrl) || selected?.url || ''
  if (!id || !authorId || !playUrl) return null

  const durationMs = Number(photo.duration ?? 0)
  const timestamp = Number(photo.timestamp ?? photo.createTime ?? 0)
  const comments = count(photo.commentCount)

  return {
    awemeId: id,
    title: text(photo.caption) || text(photo.originCaption),
    authorSecUid: authorId,
    authorNickname: text(author.name ?? author.nickname),
    authorHomeUrl: `https://www.kuaishou.com/profile/${encodeURIComponent(authorId)}`,
    playUrl,
    coverUrl: coverUrl(photo),
    width: selected?.width ?? positiveInteger(photo.width),
    height: selected?.height ?? positiveInteger(photo.height),
    durationSec: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0,
    publishTime: Number.isFinite(timestamp) && timestamp > 1_000_000_000_000 ? timestamp / 1000 : (Number.isFinite(timestamp) ? timestamp : 0),
    likes: count(photo.likeCount) ?? 0,
    comments,
    sourceUrl: buildVideoUrl(id)
  }
}

const AUTHOR_URL_RE = /^https?:\/\/(?:www\.)?kuaishou\.com\/profile\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i
const BARE_USER_ID_RE = /^[A-Za-z0-9_-]+$/

export function isKuaishouShortLink(raw: string): boolean {
  return /^https?:\/\/(?:v|c)\.kuaishou\.com\//i.test(raw.trim()) || /^https?:\/\/kuaishou\.com\/f\//i.test(raw.trim())
}

export function parseKuaishouAuthorInput(raw: string): string | null {
  const input = raw.trim()
  if (!input || isKuaishouShortLink(input)) return null
  const match = input.match(AUTHOR_URL_RE)
  if (match) return match[1]
  return BARE_USER_ID_RE.test(input) ? input : null
}

export const kuaishouAdapter: PlatformAdapter = {
  name: 'kuaishou',
  displayName: '快手',
  sourceHosts: ['www.kuaishou.com'],
  sessionPartition: 'persist:kuaishou',
  apiUrlPatterns: [/\/graphql(?:[/?#]|$)/i],
  rawUrlHints: ['/graphql'],
  buildSearchUrl: (query: string) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(query)}`,
  buildAuthorUrl: (userId: string) => `https://www.kuaishou.com/profile/${encodeURIComponent(userId)}`,
  buildHashtagUrl: (query: string) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(`#${query}`)}`,
  buildVideoUrl,
  parseAuthorInput: parseKuaishouAuthorInput,
  matchesTaskResponse: (type: TaskType, _url: string, json: unknown) => matchesKuaishouTaskResponse(type, json),
  parseApiJson: (_url: string, json: unknown) => collectKuaishouPhotos(json)
    .map(parsePhoto)
    .filter((item): item is VideoItem => item !== null),
  normalizePlayUrl: (rawUrl: string) => rawUrl
}
