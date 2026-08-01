import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  downloadDir: join(app.getPath('downloads'), '爬取视频'),
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  downloadConcurrency: 3,
  scrollIntervalMs: 2000,
  addressTtlMin: 30
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
