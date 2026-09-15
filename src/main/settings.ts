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
  // 归档层级：全新安装默认四层全关，视频平铺在下载目录。
  // 员工反馈旧版 {品类}/{作者}/{横竖屏}/{时长} 四层套下来文件夹太多、翻不动。
  organizeByCategory: false,
  organizeByAuthor: false,
  organizeByOrientation: false,
  organizeByDuration: false
}

/** 升级前的老用户行为：四层全开。
 *  判据是「settings.json 存在且能解析」——有配置文件就说明是升级而非全新安装。
 *  只作用于文件里缺失的键；用户显式存过的值不受影响。
 *  不这样兜底的话，老用户升级后归档会静默停掉，下载目录突然从分类变平铺。 */
const LEGACY_ORGANIZE_LEVELS: Pick<
  AppSettings,
  'organizeByCategory' | 'organizeByAuthor' | 'organizeByOrientation' | 'organizeByDuration'
> = {
  organizeByCategory: true,
  organizeByAuthor: true,
  organizeByOrientation: true,
  organizeByDuration: true
}

/** 已从产品里撤下的旧键：统一分辨率曾是下载行为设置，现在是「视频处理」页的手动批处理。
 *  读取时直接丢弃，既不进 AppSettings 也不会在下次保存时被写回，老配置文件不用手工清理。 */
const RETIRED_KEYS = ['normalizeVideo', 'keepOriginalVideo'] as const

export function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8')
    const stored = JSON.parse(raw) as Record<string, unknown>
    for (const key of RETIRED_KEYS) delete stored[key]
    // 配置文件存在 = 老用户升级：归档层级缺失键按升级前行为（全开）兜底，再让文件里的显式值覆盖
    return { ...DEFAULTS, ...LEGACY_ORGANIZE_LEVELS, ...(stored as Partial<AppSettings>) }
  } catch { return { ...DEFAULTS } }
}

export function saveSettings(s: AppSettings): void {
  const f = settingsFile()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8')
}
