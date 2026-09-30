export type TaskType = 'keyword' | 'author' | 'hashtag'
export type TaskStatus = 'pending' | 'running' | 'done' | 'paused' | 'failed'
export type VideoStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'filtered' | 'collected' | 'cancelled' | 'paused'
export type TimeRange = 'all' | '7d' | '30d' | 'custom'
export type DurationFilter = 'all' | 'under30' | 'short' | 'medium' | 'long' | 'custom'

export interface Filters {
  timeRange: TimeRange
  startDate?: string // ISO date，timeRange='custom' 时必填
  endDate?: string
  duration: DurationFilter
  durationMinSec?: number
  durationMaxSec?: number
  targetCount: number
  aiFilterRule?: string
  aiFilterEnabled?: boolean // createTask 会把它序列化进 filters JSON 列（Task 6）
  aiOrganizeEnabled?: boolean // 同上，任务级开关随 filters 落库
}

export interface CreateTaskInput {
  platform: string
  type: TaskType
  query: string
  filters: Filters
  aiFilterEnabled: boolean
  aiOrganizeEnabled: boolean
  autoDownload: boolean // 自动下载（false=手动模式，视频入 collected）
  allowDuplicateAuthor?: boolean // type=author 时覆盖全局设置：允许重复爬取已爬过主页的作者
  /** R19：这个任务的视频下到哪（绝对路径）。发布助手用它把达人的视频直接下到达人自己的「暂存」；不给 = 设置里的下载目录 */
  outputDir?: string
}

export interface TaskRow {
  id: number; platform: string; type: TaskType; query: string
  filters: string; status: TaskStatus; target_count: number; fetched_count: number
  auto_download: number
  error: string | null; created_at: string; finished_at: string | null
  /** R19：任务自己的下载文件夹（外部程序经本机接口指定）；空 = 用设置里的下载目录 */
  output_dir?: string | null
  /** 仅 type='author' 时由 listTasks 关联带出；query 存的是 sec_uid，直接显示人认不出来 */
  author_nickname?: string | null
}

/** 一个任务下视频按状态计数（进度展示 + 手动模式提示条） */
export interface TaskStats {
  total: number; done: number; failed: number; downloading: number; pending: number; filtered: number
  collected: number; cancelled: number; paused: number
}

/** 任务进度瞬时推送（main → 渲染层 evt:task:progress；R11 Task1 起带 reSearchCount，Task2 用于界面显示「已重搜 N 次」） */
export interface TaskProgressEvent {
  type: 'task:progress'
  taskId: number
  fetched: number
  status: TaskStatus
  reSearchCount?: number
}

export interface VideoRow {
  id: number; platform: string; task_id: number; aweme_id: string; title: string
  author_id: number | null; play_addr: string | null; source_url: string | null; duration: number
  cover_url: string | null; cover_path: string | null
  original_path: string | null
  normalization_error: string | null
  video_width: number; video_height: number
  organize_retry?: number // 成对移动回滚失败：路径记录实际位置，后续整理仍需重试
  publish_time: string | null; stats: string; ai_verdict: 'pass' | 'filtered' | null
  ai_tags: string | null; status: VideoStatus; local_path: string | null
  file_size: number | null; error: string | null; retry_count: number
  fetched_at: string; downloaded_at: string | null
  author_nickname?: string | null // listVideos 联查 authors 得到的作者昵称
}

export interface AuthorRow {
  id: number; platform: string; sec_uid: string; nickname: string
  home_url: string | null; video_count: number; last_fetched_at: string | null; note: string | null
  category: string | null
  organize_state: string | null; ai_classified_at: string | null // Task2 归档状态与 AI 分类时间
  /** 导入作者的校验状态：null=无需校验（抓取收录）/ pending / ok / failed */
  verify_state: string | null; verify_error: string | null
}

/** 文件管理：下载目录扫描结果——通用目录树（以磁盘为准，不假定任何一层是品类或作者）。
 *  归档层级四个开关各自可关，目录结构完全由设置决定；根目录直属的 mp4 与子目录同样可见。
 *  videoCount/size 是递归合计（.original.mp4 与隐藏/临时项不计）；totalSize = 根节点合计；downloadDir 供前端拼定位路径。 */
export interface FilesVideoFile { name: string; size: number }
export interface FilesDirNode { name: string; videoCount: number; size: number; dirs: FilesDirNode[]; files: FilesVideoFile[] }
export interface FilesTree { root: FilesDirNode; totalSize: number; downloadDir: string }

/** 视频处理页：一个待处理文件的生命周期。skipped = 已符合 1080p 标准无需转码；stopped = 用户点停止后未处理/被中止 */
export type ProcessItemStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'failed' | 'stopped'
export interface ProcessItem {
  /** 绝对路径（主进程用）；界面只显示 name */
  path: string
  name: string
  status: ProcessItemStatus
  /** 源显示尺寸 / 目标尺寸，探测到才有 */
  source?: { width: number; height: number }
  target?: { width: number; height: number }
  /** 稳定错误码（media_probe_failed / ffmpeg_not_found / ffmpeg_failed / output_invalid / backup_exists / replace_failed） */
  error?: string
}
/** 视频处理页整体阶段：idle → running ⇄ paused → finished；stop 后 stopping → stopped */
export type ProcessPhase = 'idle' | 'running' | 'paused' | 'stopping' | 'finished' | 'stopped'
export interface ProcessState {
  phase: ProcessPhase
  dir: string | null
  total: number
  /** 已完成 = 转码成功 + 已兼容跳过 */
  completed: number
  done: number
  skipped: number
  failed: number
  processing: number
  remaining: number
  /** 正在处理的文件（并发 1 时最多一个；尺寸在探测后补上） */
  current: Pick<ProcessItem, 'name' | 'source' | 'target'> | null
  items: ProcessItem[]
  /** 简洁运行日志（最新在后，最多保留 200 行） */
  log: string[]
}

/** 文件管理删除结果：deleted = DB 删除的视频行数（文件夹删除成功与否看 ok/filesRemoved） */
export interface FileDeleteResult {
  ok: boolean
  deleted: number
  filesRemoved?: boolean
  error?: string
}

export interface AppSettings {
  downloadDir: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  downloadConcurrency: number
  scrollIntervalMs: number
  /** T2：滚动速度三档（档位预设 scrollPageWaitMs 初始值：慢8s/中5s/快3s；数字微调直接生效） */
  scrollSpeed: 'slow' | 'medium' | 'fast'
  /** T2：每页最大等待毫秒（scrollToBottom 的 waitForGrowth 超时；默认 8000=8s） */
  scrollPageWaitMs: number
  addressTtlMin: number
  /** 勾选=允许重复爬取已爬过主页的作者；取消=去重跳过 */
  allowDuplicateAuthor: boolean
  /** 下载完成→按作者归档去抖毫秒（Task5 触发整理用，设置面板在 Task14 加） */
  organizeDebounceMs: number
  /** ASR 转写只取视频前 N 秒（Task14 设置接入；默认 90） */
  asrMaxSec: number
  /** R11：停滞判定阈值秒数（默认 5；Date.now()-lastFetchedAt > 秒数*1000 即判爬不动，进入自救循环） */
  stallThresholdSec: number
  /** R12：重搜冷却秒数（停滞自救两次重搜的最小间隔，默认 10；到底文案命中可忽略冷却立即重搜） */
  rescueCooldownSec: number
  /** R20：卡住判定分钟数（默认 5）——任务这么久没抓到新数据、页面也没在滚，就强制停下、标「卡住了」，放行后面排队的任务 */
  stuckTimeoutMin: number
  /** 归档层级：按品类建目录（需要 AI 解析品类；关闭后不再调用 resolveCategory） */
  organizeByCategory: boolean
  /** 归档层级：按作者建目录 */
  organizeByAuthor: boolean
  /** 归档层级：按横屏/竖屏/未识别建目录（关闭后不再对缺尺寸的视频跑 ffprobe） */
  organizeByOrientation: boolean
  /** 归档层级：按一分钟内/一分钟外建目录 */
  organizeByDuration: boolean
  /** R18：本机 HTTP 口（给百家号发布助手等外部程序建抓取任务用）；只绑 127.0.0.1 */
  bridgeEnabled: boolean
  bridgePort: number
}

/** ASR 单个模型文件的状态（models.status() 的结果形状，跨进程用） */
export interface AsrModelFileStatus {
  key: string
  label: string
  path: string
  expectBytes: number
  actualBytes: number
  ok: boolean
}

/** ASR 模型目录整体状态（asr:status 通道返回） */
export interface AsrStatus {
  dir: string
  ready: boolean
  files: AsrModelFileStatus[]
  totalBytes: number
}

/** ASR 模型下载整体进度（asr:download 经 evt:asr:progress 推给渲染层，画进度条用） */
export interface AsrProgress {
  phase: 'start' | 'downloading' | 'done'
  label: string
  host?: string
  received: number
  total: number
}

/** R20：卡住判定分钟数的允许范围（设置页保存时夹紧；调度器读的时候再夹一次，手改 settings.json 也不怕） */
export const STUCK_TIMEOUT_MIN_RANGE = { min: 2, max: 60, default: 5 } as const
/** 空 / 非数字 → 默认 5；小于 2 → 2；大于 60 → 60；小数取整 */
export function clampStuckTimeoutMin(v: unknown): number {
  const n = Math.round(Number(v))
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n <= 0) return STUCK_TIMEOUT_MIN_RANGE.default
  return Math.min(STUCK_TIMEOUT_MIN_RANGE.max, Math.max(STUCK_TIMEOUT_MIN_RANGE.min, n))
}

export const ERROR = {
  NETWORK: 'network', ADDRESS_EXPIRED: 'address_expired', FORBIDDEN: 'forbidden',
  LOGIN_EXPIRED: 'login_expired', DISK: 'disk', PARSE_ERROR: 'parse_error',
  AI_AUTH: 'ai_auth', AI_QUOTA: 'ai_quota', AI_TIMEOUT: 'ai_timeout'
} as const

/** 概览页：全站聚合计数（两条 GROUP BY，代替 1 + N 次调用） */
export interface GlobalStats {
  videos: { total: number; pending: number; downloading: number; done: number; failed: number; filtered: number; collected: number; cancelled: number; paused: number }
  tasks: { total: number; pending: number; running: number; done: number; paused: number; failed: number }
}

/** 概览页：最近完成的下载一行 */
export interface RecentDownload {
  id: number
  title: string
  downloaded_at: string | null
  author_nickname: string | null
}
