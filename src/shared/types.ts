export type TaskType = 'keyword' | 'author' | 'hashtag'
export type TaskStatus = 'pending' | 'running' | 'done' | 'paused' | 'failed'
export type VideoStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'filtered' | 'collected' | 'cancelled'
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
}

/** 一个任务下视频按状态计数（进度展示 + 手动模式提示条） */
export interface TaskStats {
  total: number; done: number; failed: number; downloading: number; pending: number; filtered: number
  collected: number; cancelled: number
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
}

export interface AppSettings {
  downloadDir: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  downloadConcurrency: number
  scrollIntervalMs: number
  addressTtlMin: number
  /** 勾选=允许重复爬取已爬过主页的作者；取消=去重跳过 */
  allowDuplicateAuthor: boolean
  /** 下载完成→按作者归档去抖毫秒（Task5 触发整理用，设置面板在 Task14 加） */
  organizeDebounceMs: number
  /** ASR 转写只取视频前 N 秒（Task14 设置接入；默认 90） */
  asrMaxSec: number
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
