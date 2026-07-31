import type { Filters } from '../../shared/types'

/** 统一视频项：各平台原始 JSON 解析后的归一结构 */
export interface VideoItem {
  awemeId: string
  title: string
  authorSecUid: string
  authorNickname: string
  authorHomeUrl: string
  playUrl: string
  durationSec: number
  publishTime: number // unix 秒
  likes: number
}

/** 平台适配器契约：核心模块只认这个接口，平台差异全部封在里面 */
export interface PlatformAdapter {
  name: string
  displayName: string
  /** 登录态分区，如 'persist:douyin' */
  sessionPartition: string
  /** 挂钩脚本需要转发的接口 URL 特征 */
  apiUrlPatterns: RegExp[]
  buildSearchUrl(query: string, filters: Filters): string
  buildAuthorUrl(secUid: string): string
  buildHashtagUrl(query: string): string
  parseApiJson(url: string, json: unknown): VideoItem[]
  normalizePlayUrl(rawUrl: string): string
}
