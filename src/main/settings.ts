import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  downloadDir: join(app.getPath('downloads'), '爬取视频'),
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  downloadConcurrency: 3,
  // R18：默认关。开着的话每条视频下载完都要 libx264 重编码（preset medium），并发 3 路同时转码，
  // 用户实测「下载异常的慢」就是它；要交给百家号发布助手处理的视频本来就会再编码一遍，没必要在这里做。
  normalizeVideo: false,
  keepOriginalVideo: false,
  scrollIntervalMs: 3500, // R12：默认滚动间隔放慢（2000→3500）降风控
  scrollSpeed: 'slow',
  scrollPageWaitMs: 8000,
  addressTtlMin: 30,
  allowDuplicateAuthor: false,
  organizeDebounceMs: 5000,
  asrMaxSec: 90,
  // R15：5 → 25。5 会被 scheduler 的动态下限抬到 15.5（勉强及格线），25 是真机实测跑通的值；
  // 且内置「使用说明」页告诉员工这里应为 25，全新安装若仍是 5 会与说明页自相矛盾。
  stallThresholdSec: 25,
  rescueCooldownSec: 10, // R12：重搜冷却秒数（停滞自救两次重搜最小间隔）
  bridgeEnabled: true, // R18：本机 HTTP 口，百家号发布助手靠它下「爬某作者主页 N 条」的任务
  bridgePort: 47321
}

export function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8')
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch { return { ...DEFAULTS } }
}

export function saveSettings(s: AppSettings): void {
  const f = settingsFile()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8')
}
