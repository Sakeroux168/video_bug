import type { Filters, SortBy, TaskType } from '../../shared/types'

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
  /** 拿不到时可以不给（入库时按 null 处理） */
  comments?: number | null
  /** 作品原链接；拿不到时可以不给（入库时按 null 处理） */
  sourceUrl?: string
  /** 收藏 / 分享 / 播放数（2026-10-07 补数据）。平台不给就不填——不能当成 0 */
  collects?: number
  shares?: number
  plays?: number
}

/** 平台能给哪些额外互动数（界面据此决定显示哪些门槛和列） */
export type InteractionField = 'collects' | 'shares' | 'plays'

/** 平台适配器契约：核心模块只认这个接口，平台差异全部封在里面 */
export interface ListStub {
  noteId: string
  detailToken: string
  /** 详情入口的实际来源。搜索通常是 pc_search，作者主页是 pc_user。 */
  detailSource?: string
  /** 作者主页卡片会给出带临时令牌的完整详情地址；仅在本次任务内存中使用。 */
  detailUrl?: string
  title: string
  authorId: string
  authorNickname: string
  coverUrl: string
  likes: number | null
  comments: number | null
  /** 列表卡片上的收藏数（小红书有）；用于列表阶段按收藏门槛筛 */
  collects?: number | null
}

export interface ListStubResult {
  stubs: ListStub[]
  skipped: { image: number; other: number }
  hasMore?: boolean
}

export interface NativeSearchFilter {
  group: string
  option: string
}

/**
 * 快速模式详情取数结果。reason 必须是固定文案或从错误类型推导，
 * 不得携带响应体片段 / URL 查询串——详情地址带 xsec_token，落日志前一律脱敏。
 */
export type FastDetailOutcome =
  | { kind: 'ok'; item: VideoItem }
  | { kind: 'login' }   // 被重定向到登录页 → 调度器按 login_required 暂停
  | { kind: 'verify' }  // 被重定向到验证码页 → 调度器按 stalled_verify 暂停
  | { kind: 'skip'; reason: string }

export interface PlatformAdapter {
  name: string
  displayName: string
  /** 解析器是否已按真机接口实现。false 表示只能在内置浏览器里打开（扫码登录、抓包），
   *  不能建任务——避免「平台出现在下拉框里、选了却跑不通」的半成品状态。 */
  taskReady: boolean
  supportedTaskTypes?: readonly TaskType[]
  /** 能拿到的额外互动数（真机核对过的）。没有的平台，界面不显示对应门槛 */
  interactions?: readonly InteractionField[]
  /** 网页筛选面板上能选的排序（真机核对过的）；没有就不显示「排序」 */
  sortOptions?: readonly SortBy[]
  /**
   * 选了排序时，这份接口响应是不是按要求排过序的（抖音靠搜索接口的 sort_type 参数分辨）。
   * 页面刚打开时按综合排序返回的那批要丢掉，否则会混进不热门的视频。
   */
  acceptsSortedResponse?(url: string, filters: Filters): boolean
  /** 可由主进程打开的作品页精确主机白名单 */
  sourceHosts: readonly string[]
  /** 登录态分区，如 'persist:douyin' */
  sessionPartition: string
  /** 平台首页。用户在「内置浏览器」页主动打开某个平台（扫码登录只能在各自窗口里做）时加载它。 */
  homeUrl: string
  /** 作者输入框 placeholder：该平台主页链接长什么样 */
  authorInputPlaceholder: string
  /** 下载媒体时带的 Referer。集中在适配器里，不靠 `www.{platform}.com` 拼字符串——
   *  后续平台若换域名或用非 .com 主机，拼字符串会静默拿到 403。 */
  downloadReferer: string
  /** 视频 / 封面下载只认这些域名（含子域名）；别的地址一律不请求（2026-10-07 安全加固 A8） */
  downloadHosts: readonly string[]
  /** 平台窗口的主页面只能跳到这些域名（含子域名，要包括登录、验证页）；别的交给系统浏览器（2026-10-07 L1） */
  navHosts: readonly string[]
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
  /** 两段式平台必须同时实现这四个方法。令牌仅在当前任务内存中保存。 */
  parseListStubs?(url: string, json: unknown): ListStubResult
  /** 页面原生筛选。它只用于减少无效候选，最终仍由详情字段做精确过滤。 */
  nativeSearchFilters?(type: TaskType, filters: Filters): NativeSearchFilter[]
  /** 某些列表（小红书作者主页）把详情令牌只放在卡片链接里，需要从当前 DOM 收集。 */
  buildListDomScript?(type: TaskType): string | null
  parseListDomResult?(value: unknown): ListStubResult
  buildDetailUrl?(stub: ListStub): string
  /** 详情接口不触发时，从页面已注水状态读取当前笔记；脚本必须核对 noteId，且不得返回令牌。 */
  buildDetailDomScript?(noteId: string): string | null
  isDetailResponse?(url: string, json: unknown, noteId?: string): boolean
  parseDetail?(json: unknown): VideoItem | null
  /** 快速模式：不在窗口里导航，用登录态 session 拉详情 HTML 后解析注水状态。
   *  finalUrl 是跟随重定向后的最终地址（登录页/验证码页靠它识别）。 */
  parseDetailHtml?(finalUrl: string, html: string, noteId: string): FastDetailOutcome
  normalizePlayUrl(rawUrl: string): string
}
