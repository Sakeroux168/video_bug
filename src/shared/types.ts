export type TaskType = 'keyword' | 'author' | 'hashtag'
export type TaskStatus = 'pending' | 'running' | 'done' | 'paused' | 'failed'
export type VideoStatus = 'pending' | 'downloading' | 'done' | 'failed' | 'filtered'
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
}

export interface TaskRow {
  id: number; platform: string; type: TaskType; query: string
  filters: string; status: TaskStatus; target_count: number; fetched_count: number
  error: string | null; created_at: string; finished_at: string | null
}

export interface VideoRow {
  id: number; platform: string; task_id: number; aweme_id: string; title: string
  author_id: number | null; play_addr: string | null; duration: number
  publish_time: string | null; stats: string; ai_verdict: 'pass' | 'filtered' | null
  ai_tags: string | null; status: VideoStatus; local_path: string | null
  file_size: number | null; error: string | null; retry_count: number
  fetched_at: string; downloaded_at: string | null
}

export interface AuthorRow {
  id: number; platform: string; sec_uid: string; nickname: string
  home_url: string | null; video_count: number; last_fetched_at: string | null; note: string | null
  category: string | null
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
}

export const ERROR = {
  NETWORK: 'network', ADDRESS_EXPIRED: 'address_expired', FORBIDDEN: 'forbidden',
  LOGIN_EXPIRED: 'login_expired', DISK: 'disk', PARSE_ERROR: 'parse_error',
  AI_AUTH: 'ai_auth', AI_QUOTA: 'ai_quota', AI_TIMEOUT: 'ai_timeout'
} as const
