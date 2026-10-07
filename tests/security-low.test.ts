import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sanitizeCategory, sanitizeDirName } from '../src/main/organizer'
import { safeFilename } from '../src/main/filename'
import { logUrl, isPlatformNavigation, ExternalOpener } from '../src/main/security'
import { isRealPathInside } from '../src/main/pathSafety'
import { checkSettings } from '../src/shared/settingsCheck'
import { FILES } from '../src/main/asr/models'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { xiaohongshuAdapter } from '../src/main/adapters/xiaohongshu'

// 2026-10-07 安全加固 L 组（全面检查 安全 L1–L6 里还没做的部分）

describe('L2 文件夹名 / 文件名：.. 和 Windows 保留名', () => {
  it('昵称或品类是 .. / . → 不会变成「上一级目录」', () => {
    for (const bad of ['..', '.', ' .. ', '...']) {
      expect(['..', '.', '']).not.toContain(sanitizeDirName(bad))
      expect(['..', '.', '']).not.toContain(sanitizeCategory(bad))
    }
  })
  it('CON / NUL / COM1 这类 Windows 保留名前面加 _；结尾的点和空格去掉；控制字符换掉', () => {
    expect(sanitizeDirName('CON')).toBe('_CON')
    expect(sanitizeDirName('nul.txt')).toBe('_nul.txt')
    expect(sanitizeCategory('com1')).toBe('_com1')
    expect(sanitizeDirName('作者. ')).toBe('作者')
    expect(sanitizeDirName('a\u0001b')).toBe('a_b')
  })
  it('标题是 con → 文件名不会是设备名', () => {
    expect(safeFilename('con', '作者', 'id1')).toBe('_con')
    expect(safeFilename('正常标题', '作者', 'id1')).toBe('正常标题')
    expect(safeFilename('结尾有点...', '作者', 'id1')).toBe('结尾有点')
  })
})

describe('L3 日志里的地址不带 ? 后面那串参数', () => {
  it('只留站点和路径', () => {
    expect(logUrl('https://www.douyin.com/aweme/v1/web/search/item/?device_id=123&msToken=abc')).toBe('https://www.douyin.com/aweme/v1/web/search/item/')
    expect(logUrl('//edith.xiaohongshu.com/api/sns/web/v1/feed?xsec_token=SECRET')).toBe('//edith.xiaohongshu.com/api/sns/web/v1/feed')
    expect(logUrl('/aweme/v1/web/x?a=1#h')).toBe('/aweme/v1/web/x')
    expect(logUrl('')).toBe('')
  })
})

describe('L1 平台窗口只在自己平台的网站里跳', () => {
  it('本平台的网站（含登录、验证用的子域名）放行；别的网站不放', () => {
    expect(isPlatformNavigation(douyinAdapter, 'https://www.douyin.com/search/猫')).toBe(true)
    expect(isPlatformNavigation(douyinAdapter, 'https://sso.douyin.com/login')).toBe(true)
    expect(isPlatformNavigation(douyinAdapter, 'https://verify.zijieapi.com/x')).toBe(true)
    expect(isPlatformNavigation(xiaohongshuAdapter, 'https://www.xiaohongshu.com/explore/1')).toBe(true)
    expect(isPlatformNavigation(douyinAdapter, 'https://evil.example.com/')).toBe(false)
    expect(isPlatformNavigation(douyinAdapter, 'https://www.xiaohongshu.com/')).toBe(false)
    expect(isPlatformNavigation(douyinAdapter, 'http://127.0.0.1/')).toBe(false)
  })

  it('页面弹出的外部网页：只放 http(s)，5 秒内最多开一个（页面不能一直往系统浏览器里弹）', () => {
    let now = 0
    const opened: string[] = []
    const o = new ExternalOpener({ open: u => opened.push(u), now: () => now })
    o.open('https://a.example.com/')
    o.open('https://b.example.com/')
    o.open('javascript:alert(1)')
    now = 6000
    o.open('https://c.example.com/')
    expect(opened).toEqual(['https://a.example.com/', 'https://c.example.com/'])
  })
})

describe('L4 语音模型文件都有指纹校验', () => {
  it('每个文件都写了 sha256', () => {
    for (const f of FILES) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('L6 设置校验', () => {
  const ok = { downloadDir: 'D:\\爬取视频', aiBaseUrl: 'https://api.openai.com/v1' }
  it('正常设置通过', () => {
    expect(checkSettings(ok)).toBeNull()
    expect(checkSettings({ ...ok, aiBaseUrl: '' })).toBeNull()
    expect(checkSettings({ ...ok, aiBaseUrl: 'http://127.0.0.1:11434/v1' })).toBeNull()
    expect(checkSettings({ ...ok, aiBaseUrl: 'http://localhost:1234/v1' })).toBeNull()
  })
  it('下载目录不能是盘根、系统目录、用户目录本身', () => {
    for (const dir of ['C:\\', 'D:', 'D:/', 'C:\\Windows', 'C:\\Windows\\Temp\\x', 'C:\\Program Files', 'c:\\program files (x86)\\a', 'C:\\Users\\张三', 'C:\\Users\\张三\\']) {
      expect(checkSettings({ ...ok, downloadDir: dir }), dir).toMatch(/下载目录/)
    }
    expect(checkSettings({ ...ok, downloadDir: 'C:\\Users\\张三\\Downloads\\爬取视频' })).toBeNull()
  })
  it('AI 地址要是 https（本机的 localhost / 127.0.0.1 除外），不然 Key 会明文发出去', () => {
    expect(checkSettings({ ...ok, aiBaseUrl: 'http://api.example.com/v1' })).toMatch(/https/)
    expect(checkSettings({ ...ok, aiBaseUrl: 'ftp://x' })).toMatch(/https/)
  })
})

describe('L6 删除按真实路径判断（目录联接指到外面的不删）', () => {
  let root: string
  let outside: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'real-in-'))
    outside = mkdtempSync(join(tmpdir(), 'real-out-'))
  })
  afterEach(() => {
    rmSync(join(root, 'link'), { recursive: false, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('下载目录里的普通文件 → 在里面；联接指到外面的 → 不在里面', () => {
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.mp4'), 'x')
    writeFileSync(join(outside, 'secret.mp4'), 'x')
    symlinkSync(outside, join(root, 'link'), 'junction')
    expect(isRealPathInside(root, join(root, 'sub', 'a.mp4'))).toBe(true)
    expect(isRealPathInside(root, join(root, 'link', 'secret.mp4'))).toBe(false)
    expect(isRealPathInside(root, join(root, 'link'))).toBe(false)
    expect(existsSync(join(outside, 'secret.mp4'))).toBe(true)
  })

  it('还不存在的路径按字面判断', () => {
    expect(isRealPathInside(root, join(root, 'not-yet', 'x.mp4'))).toBe(true)
    expect(isRealPathInside(root, join(root, '..', 'x.mp4'))).toBe(false)
  })
})

describe('L5 主界面的内容安全策略', () => {
  it('构建时往 <head> 里加 CSP：脚本只认本地，素材库封面 vs-cover: 能显示', async () => {
    const { injectCsp } = await import('../src/shared/csp')
    const html = injectCsp('<!doctype html><html><head><title>x</title></head></html>')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toMatch(/script-src 'self'[;"]/)
    expect(html).toContain('img-src \'self\' data: vs-cover:')
  })
})
