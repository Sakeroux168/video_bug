import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../src/shared/types'

// settings.ts 默认值合并 / 损坏 JSON 回落 / 持久化（主进程纯逻辑）。
// mock electron：downloads 与 userData 指向本测试专属临时目录。

const mockPaths = vi.hoisted(() => ({
  userData: process.cwd() + '/.tmp-settings-test/userData',
  downloads: process.cwd() + '/.tmp-settings-test/downloads'
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string): string => (name === 'downloads' ? mockPaths.downloads : mockPaths.userData) }
}))

import { getSettings, saveSettings } from '../src/main/settings'

/** 一份字段齐全的设置（saveSettings 的入参形状） */
function fullSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    downloadDir: join(mockPaths.downloads, '爬取视频'),
    aiBaseUrl: 'https://api.openai.com/v1',
    aiApiKey: 'sk-test',
    aiModel: 'gpt-4o-mini',
    downloadConcurrency: 5,
    scrollIntervalMs: 1500,
    scrollSpeed: 'fast',
    scrollPageWaitMs: 3000,
    addressTtlMin: 60,
    allowDuplicateAuthor: true,
    organizeDebounceMs: 1000,
    asrMaxSec: 120,
    stallThresholdSec: 10,
    rescueCooldownSec: 10,
    stuckTimeoutMin: 5,
    organizeByCategory: false,
    organizeByAuthor: true,
    organizeByOrientation: false,
    organizeByDuration: true,
    bridgeEnabled: true,
    bridgePort: 47321,
    ...over
  }
}

describe('settings', () => {
  beforeEach(() => { mkdirSync(mockPaths.userData, { recursive: true }) })
  afterEach(() => { rmSync(process.cwd() + '/.tmp-settings-test', { recursive: true, force: true }) })

  it('无配置文件 → 返回默认值（下载目录 = downloads/爬取视频，关键参数齐全）', () => {
    const s = getSettings()
    expect(s.downloadDir).toBe(join(mockPaths.downloads, '爬取视频'))
    expect(s.downloadConcurrency).toBe(3)
    expect(s.scrollSpeed).toBe('slow')
    expect(s.scrollPageWaitMs).toBe(8000)
    expect(s.allowDuplicateAuthor).toBe(false)
    expect(s.organizeDebounceMs).toBe(5000)
    expect(s.asrMaxSec).toBe(90)
    // R15：默认改 5 → 25。5 会被 scheduler 的动态下限抬到 15.5（勉强及格线），
    // 25 才是真机实测跑通的值；且内置「使用说明」页明确告诉员工这里应为 25，
    // 全新安装若仍是 5，设置页显示值与说明页自相矛盾。
    expect(s.stallThresholdSec).toBe(25)
    expect(s.rescueCooldownSec).toBe(10)
    expect(s.stuckTimeoutMin).toBe(5) // R20：卡住判定默认 5 分钟
    expect(s.scrollIntervalMs).toBe(3500) // R12：默认滚动间隔放慢降风控
    // 归档层级：全新安装默认四层全关 —— 视频平铺在下载目录，不再套四层文件夹
    expect(s.organizeByCategory).toBe(false)
    expect(s.organizeByAuthor).toBe(false)
    expect(s.organizeByOrientation).toBe(false)
    expect(s.organizeByDuration).toBe(false)
  })

  it('已有配置文件但缺归档层级键 → 视为升级前老用户，四层全开（行为不变）', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({ downloadConcurrency: 5 }))
    const s = getSettings()
    // 老用户升级不能静默停掉归档：settings.json 存在即证明是升级而非全新安装
    expect(s.organizeByCategory).toBe(true)
    expect(s.organizeByAuthor).toBe(true)
    expect(s.organizeByOrientation).toBe(true)
    expect(s.organizeByDuration).toBe(true)
    expect(s.downloadConcurrency).toBe(5) // 其它字段照常合并
  })

  it('已有配置文件且显式存了归档层级 → 按存的值读回，不被老用户兜底覆盖', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({
      organizeByCategory: false, organizeByAuthor: true, organizeByOrientation: false, organizeByDuration: false
    }))
    const s = getSettings()
    expect(s.organizeByCategory).toBe(false)
    expect(s.organizeByAuthor).toBe(true)
    expect(s.organizeByOrientation).toBe(false)
    expect(s.organizeByDuration).toBe(false)
  })

  it('已有配置文件只关了一层 → 其余缺失键仍按老用户兜底为开', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({ organizeByCategory: false }))
    const s = getSettings()
    expect(s.organizeByCategory).toBe(false)
    expect(s.organizeByAuthor).toBe(true)
    expect(s.organizeByOrientation).toBe(true)
    expect(s.organizeByDuration).toBe(true)
  })

  it('部分字段已保存 → 读回合并默认值（不丢失未存字段）', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({ downloadConcurrency: 5, allowDuplicateAuthor: true }))
    const s = getSettings()
    expect(s.downloadConcurrency).toBe(5)
    expect(s.allowDuplicateAuthor).toBe(true)
    expect(s.aiModel).toBe('gpt-4o-mini') // 未存字段回落到默认
    expect(s.downloadDir).toBe(join(mockPaths.downloads, '爬取视频'))
  })

  it('旧配置文件里的 normalizeVideo/keepOriginalVideo 被丢弃：不进设置对象，保存后也不写回', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({
      downloadConcurrency: 4, normalizeVideo: true, keepOriginalVideo: true
    }))
    const s = getSettings() as AppSettings & Record<string, unknown>
    expect(s.downloadConcurrency).toBe(4)
    expect('normalizeVideo' in s).toBe(false)
    expect('keepOriginalVideo' in s).toBe(false)
    saveSettings(s)
    const written = JSON.parse(readFileSync(join(mockPaths.userData, 'settings.json'), 'utf-8')) as Record<string, unknown>
    expect('normalizeVideo' in written).toBe(false)
    expect('keepOriginalVideo' in written).toBe(false)
  })

  it('配置文件损坏（非法 JSON）→ 回落默认值，不抛错', () => {
    writeFileSync(join(mockPaths.userData, 'settings.json'), '{ 不是 JSON !!')
    expect(() => getSettings()).not.toThrow()
    const s = getSettings()
    expect(s.downloadConcurrency).toBe(3)
    expect(s.scrollSpeed).toBe('slow')
  })

  it('saveSettings 写入文件 → getSettings 完整读回（持久化闭环）', () => {
    const full = fullSettings()
    saveSettings(full)
    const f = join(mockPaths.userData, 'settings.json')
    expect(existsSync(f)).toBe(true)
    // 文件内容即为保存值
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual(full)
    expect(getSettings()).toEqual(full)
  })

  it('saveSettings 后修改文件内容 → 读回新值（settings.json 是唯一事实源）', () => {
    saveSettings(fullSettings())
    writeFileSync(join(mockPaths.userData, 'settings.json'), JSON.stringify({ downloadConcurrency: 9 }))
    const s = getSettings()
    expect(s.downloadConcurrency).toBe(9)
    expect(s.allowDuplicateAuthor).toBe(false) // 被覆盖后回落默认
  })
})
