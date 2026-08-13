export type TaskType = 'keyword' | 'author' | 'hashtag'
export type TaskStatus = 'pending' | 'running' | 'done' | 'paused' | 'failed'
export type VideoStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'filtered' | 'collected' | 'cancelled' | 'paused'
export type TimeRange = 'all' | '7d' | '30d' | 'custom'
export type DurationFilter = 'all' | 'short' | 'medium' | 'long'

export interface Filters {
  timeRange: TimeRange
  startDate?: string // ISO date，timeRange='custom' 时必填
  endDate?: string
  duration: DurationFilter
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
}

export interface TaskRow {
  id: number; platform: string; type: TaskType; query: string
  filters: string; status: TaskStatus; target_count: number; fetched_count: number
  auto_download: number
  error: string | null; created_at: string; finished_at: string | null
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
  author_id: number | null; play_addr: string | null; duration: number
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

/** 文件管理：下载目录扫描结果（品类 → 作者 → 视频，以磁盘为准；totalSize 所有 mp4 合计，downloadDir 供前端拼定位路径） */
export interface FilesTreeAuthor { name: string; videoCount: number; size: number }
export interface FilesTreeCategory { name: string; videoCount: number; size: number; authors: FilesTreeAuthor[] }
export interface FilesTree { categories: FilesTreeCategory[]; totalSize: number; downloadDir: string }

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

export const ERROR = {
  NETWORK: 'network', ADDRESS_EXPIRED: 'address_expired', FORBIDDEN: 'forbidden',
  LOGIN_EXPIRED: 'login_expired', DISK: 'disk', PARSE_ERROR: 'parse_error',
  AI_AUTH: 'ai_auth', AI_QUOTA: 'ai_quota', AI_TIMEOUT: 'ai_timeout'
} as const
