import type { Filters, TaskType } from '../../shared/types'

/** 统一视频项：各平台原始 JSON 解析后的归一结构 */
export interface VideoItem {
  awemeId: string
  title: string
  authorSecUid: string
  authorNickname: string
  authorHomeUrl: string
  playUrl: string
  coverUrl: string
  width: number
  height: number
  durationSec: number
  publishTime: number // unix 秒
  likes: number
  comments: number | null
  sourceUrl: string
}

/** 平台适配器契约：核心模块只认这个接口，平台差异全部封在里面 */
export interface PlatformAdapter {
  name: string
  displayName: string
  /** 可由主进程打开的作品页精确主机白名单 */
  sourceHosts: readonly string[]
  /** 登录态分区，如 'persist:douyin' */
  sessionPartition: string
  /** 作者输入框 placeholder：该平台主页链接长什么样 */
  authorInputPlaceholder: string
  /** 下载媒体时带的 Referer。集中在适配器里，不靠 `www.{platform}.com` 拼字符串——
   *  后续平台若换域名或用非 .com 主机，拼字符串会静默拿到 403。 */
  downloadReferer: string
  /** 挂钩脚本需要转发的接口 URL 特征 */
  apiUrlPatterns: RegExp[]
  /** XHR 响应 content-type 不标准时，按 URL 子串兜底判断该响应是否值得解析。
   *  注入脚本本身不认识任何平台，这份特征由适配器提供后注入进去。 */
  rawUrlHints: readonly string[]
  buildSearchUrl(query: string, filters: Filters): string
  buildAuthorUrl(secUid: string): string
  buildHashtagUrl(query: string): string
  buildVideoUrl(workId: string): string
  /** 解析用户粘贴的作者输入（完整主页 URL 或裸 sec_uid），返回归一化后的 sec_uid；
   *  无法识别（短链/非本平台域名/空串/非法字符）返回 null。纯字符串处理，不联网、不解析短链跳转。 */
  parseAuthorInput(raw: string): string | null
  /** 是否是该平台的短链。短链不联网解析，必须让用户粘完整主页链接——
   *  错误提示要能区分「短链」和「根本不是本平台链接」。 */
  isShortLink(raw: string): boolean
  /** 这条原始响应是否属于当前任务类型。
   *  抖音各业务走不同接口路径，看 URL 就够；快手关键词/作者/详情共用同一个 /graphql，
   *  URL 完全相同，只能看响应里出现了哪个 operation 根字段。
   *  必须拒绝推荐流、详情等无关响应——用户在浏览器里手点一条视频不能污染正在跑的任务。 */
  matchesTaskResponse(type: TaskType, url: string, json: unknown): boolean
  parseApiJson(url: string, json: unknown): VideoItem[]
  normalizePlayUrl(rawUrl: string): string
}
