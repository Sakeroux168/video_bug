import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

// 2026-10-07 安全加固 A9（全面检查 安全 M3）：AI Key 以前明文写在 settings.json 里。
// 现在用系统自带的加密（Windows 上是 DPAPI，只有这台电脑的这个 Windows 账号能解开）存成密文。

const paths = vi.hoisted(() => ({ userData: require('os').tmpdir() + '/vs-test-' + process.pid + '-settings-secret' }))
const box = vi.hoisted(() => ({ available: true, failDecrypt: false }))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
  safeStorage: {
    isEncryptionAvailable: () => box.available,
    encryptString: (s: string) => Buffer.from('ENC:' + [...s].reverse().join(''), 'utf8'),
    decryptString: (b: Buffer) => {
      if (box.failDecrypt) throw new Error('cannot decrypt')
      return [...b.toString('utf8').slice(4)].reverse().join('')
    }
  }
}))

import { getSettings, saveSettings } from '../src/main/settings'

const file = (): string => join(paths.userData, 'settings.json')

beforeEach(() => {
  rmSync(paths.userData, { recursive: true, force: true })
  mkdirSync(paths.userData, { recursive: true })
  box.available = true
  box.failDecrypt = false
})

describe('AI Key 加密存', () => {
  it('保存后文件里没有明文 Key；读回来是原来的 Key', () => {
    saveSettings({ ...getSettings(), aiApiKey: 'sk-secret-123' })
    const raw = readFileSync(file(), 'utf8')
    expect(raw).not.toContain('sk-secret-123')
    expect(JSON.parse(raw).aiApiKeyEnc).toBeTruthy()
    expect(getSettings().aiApiKey).toBe('sk-secret-123')
    expect('aiApiKeyEnc' in getSettings()).toBe(false)
  })

  it('老版本留下的明文 Key 照样能用；下次保存就变成密文', () => {
    writeFileSync(file(), JSON.stringify({ aiApiKey: 'sk-old-plain' }))
    expect(getSettings().aiApiKey).toBe('sk-old-plain')
    saveSettings(getSettings())
    expect(readFileSync(file(), 'utf8')).not.toContain('sk-old-plain')
    expect(getSettings().aiApiKey).toBe('sk-old-plain')
  })

  it('解不开（换了电脑 / 换了 Windows 账号）→ 当作没填，不报错', () => {
    saveSettings({ ...getSettings(), aiApiKey: 'sk-secret-123' })
    box.failDecrypt = true
    expect(getSettings().aiApiKey).toBe('')
  })

  it('系统不支持加密 → 退回原来的明文存法（总比存不了强）', () => {
    box.available = false
    saveSettings({ ...getSettings(), aiApiKey: 'sk-plain' })
    expect(JSON.parse(readFileSync(file(), 'utf8')).aiApiKey).toBe('sk-plain')
    expect(getSettings().aiApiKey).toBe('sk-plain')
  })

  it('Key 清空了 → 密文也清掉', () => {
    saveSettings({ ...getSettings(), aiApiKey: 'sk-secret-123' })
    saveSettings({ ...getSettings(), aiApiKey: '' })
    const stored = JSON.parse(readFileSync(file(), 'utf8'))
    expect(stored.aiApiKeyEnc).toBeUndefined()
    expect(getSettings().aiApiKey).toBe('')
  })
})

// 2026-10-07：本机接口（给百家号发布助手用的 HTTP 口）新装默认关；老用户的设置文件里没这一项时保持开（以前的默认）
describe('本机接口默认值', () => {
  it('新装（没有设置文件）→ 默认关', () => {
    expect(getSettings().bridgeEnabled).toBe(false)
  })
  it('老用户（有设置文件、没写过这一项）→ 保持开', () => {
    writeFileSync(file(), JSON.stringify({ downloadDir: 'D:/x' }))
    expect(getSettings().bridgeEnabled).toBe(true)
  })
  it('显式关过 / 开过的照旧', () => {
    writeFileSync(file(), JSON.stringify({ bridgeEnabled: false }))
    expect(getSettings().bridgeEnabled).toBe(false)
  })
})

// 2026-10-07：平台网页直连（不走系统代理）默认开——快手拒绝从代理过来的请求
describe('平台网页直连默认值', () => {
  it('新装、老用户都默认开；显式关过的照旧', () => {
    expect(getSettings().platformDirect).toBe(true)
    writeFileSync(file(), JSON.stringify({ downloadDir: 'D:/x' }))
    expect(getSettings().platformDirect).toBe(true)
    writeFileSync(file(), JSON.stringify({ platformDirect: false }))
    expect(getSettings().platformDirect).toBe(false)
  })
})
