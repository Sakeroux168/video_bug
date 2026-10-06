import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Server } from 'http'
import { initDb } from '../src/main/db'
import { startBridge, jobFromBody } from '../src/main/bridge'
import { checkBridgeRequest, isNetworkPath, isAppUrl, neutralizeCsvFormula, allowedPermission } from '../src/main/security'
import { resolveBin, type FfBinDeps } from '../src/main/ffbin'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() + '/.tmp-security-quick' } }))

// 2026-10-06 全面检查「安全隐私」A1–A6 的回归测试

describe('A1 本机接口：只认本机程序发来的请求', () => {
  const port = 47321
  const ok = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }

  it('百家号发布助手那样的请求（无 Origin、Host=127.0.0.1、JSON）放行', () => {
    expect(checkBridgeRequest('POST', ok, port)).toBeNull()
    expect(checkBridgeRequest('GET', { host: `localhost:${port}` }, port)).toBeNull()
  })

  it('带 Origin 的请求一律拒绝（网页跨站请求必带 Origin）', () => {
    expect(checkBridgeRequest('POST', { ...ok, origin: 'https://evil.example' }, port)).toMatch(/网页/)
    expect(checkBridgeRequest('GET', { host: `127.0.0.1:${port}`, origin: 'null' }, port)).toMatch(/网页/)
  })

  it('Host 不是本机地址 → 拒绝（防 DNS 重绑定）', () => {
    expect(checkBridgeRequest('GET', { host: `evil.example:${port}` }, port)).toMatch(/Host/)
    expect(checkBridgeRequest('GET', { host: `127.0.0.1:1` }, port)).toMatch(/Host/)
    expect(checkBridgeRequest('GET', {}, port)).toMatch(/Host/)
  })

  it('POST 必须是 JSON（网页表单无法不经预检直接发 JSON）', () => {
    expect(checkBridgeRequest('POST', { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, port)).toMatch(/JSON/)
    expect(checkBridgeRequest('POST', { host: `127.0.0.1:${port}`, 'content-type': 'application/json; charset=utf-8' }, port)).toBeNull()
  })

  it('outputDir 不接受 \\\\主机\\共享 这种网络路径；本地盘和映射盘照常可用', () => {
    expect(isNetworkPath('\\\\evil\\share\\a')).toBe(true)
    expect(isNetworkPath('//evil/share/a')).toBe(true)
    expect(isNetworkPath('\\\\?\\UNC\\evil\\share')).toBe(true)
    expect(isNetworkPath('Z:\\AAA\\达人\\暂存')).toBe(false)
    const base = { query: 'https://www.douyin.com/user/X' }
    expect(jobFromBody({ ...base, outputDir: '\\\\evil\\share' })).toMatch(/网络路径/)
    expect(jobFromBody({ ...base, outputDir: 'Z:\\AAA\\达人\\暂存' })).toMatchObject({ outputDir: 'Z:\\AAA\\达人\\暂存' })
  })
})

describe('A1 本机接口：真实服务上也拦得住', () => {
  let db: DatabaseSync
  let server: Server
  let base: string
  beforeEach(async () => {
    db = new DatabaseSync(':memory:'); initDb(db)
    const r = await startBridge({ db, enqueueTask: () => {}, isRunning: () => false, port: 0 })
    server = r!.server
    base = `http://127.0.0.1:${r!.port}`
  })
  afterEach(() => { server.close(); db.close() })

  it('带 Origin 的跨站 POST /job → 403，不建任务', async () => {
    const res = await fetch(base + '/job', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ query: 'https://www.douyin.com/user/X' })
    })
    expect(res.status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({ n: 0 })
  })

  it('带 Origin 的 GET /status → 403（不让网页读任务列表）', async () => {
    const res = await fetch(base + '/status', { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
  })
})

describe('A2 只有主界面能调主进程接口', () => {
  it('本软件页面（打包后 file://、开发时本机地址）可信；平台网页不可信', () => {
    expect(isAppUrl('file:///C:/app/resources/app.asar/out/renderer/index.html')).toBe(true)
    expect(isAppUrl('http://localhost:5173/')).toBe(true)
    expect(isAppUrl('http://127.0.0.1:5173/index.html')).toBe(true)
    expect(isAppUrl('https://www.douyin.com/')).toBe(false)
    expect(isAppUrl('https://evil.localhost.example/')).toBe(false)
    expect(isAppUrl('')).toBe(false)
  })
})

describe('A3 网页权限请求默认拒绝', () => {
  it('摄像头、麦克风、定位、通知等拒绝；全屏、写剪贴板允许', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'pointerLock']) expect(allowedPermission(p)).toBe(false)
    for (const p of ['fullscreen', 'clipboard-sanitized-write']) expect(allowedPermission(p)).toBe(true)
  })
})

describe('A4 导出 CSV 防公式注入', () => {
  it('= + - @ 制表符 回车 开头的文字前面加单引号；普通文字、数字不动', () => {
    expect(neutralizeCsvFormula('@某某 好物分享')).toBe("'@某某 好物分享")
    expect(neutralizeCsvFormula('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`)
    expect(neutralizeCsvFormula('+1 关注')).toBe("'+1 关注")
    expect(neutralizeCsvFormula('-减脂餐')).toBe("'-减脂餐")
    expect(neutralizeCsvFormula('\t隐藏')).toBe("'\t隐藏")
    expect(neutralizeCsvFormula('正常标题')).toBe('正常标题')
    expect(neutralizeCsvFormula('-12')).toBe('-12')
    expect(neutralizeCsvFormula('3.5')).toBe('3.5')
    expect(neutralizeCsvFormula('')).toBe('')
  })
})

describe('A5 ffmpeg 查找顺序：随包 → PATH → 老约定目录', () => {
  const deps = (files: string[], dirs: Record<string, string[]>): FfBinDeps => ({
    exists: p => files.includes(p),
    readdir: p => { if (!(p in dirs)) throw new Error('ENOENT'); return dirs[p] }
  })
  it('PATH 里有 ffmpeg 时，不去用 C:/123 这类谁都能放文件的目录', () => {
    const d = deps(['C:/123/ffmpeg-x/bin/ffmpeg.exe', 'C:/tools/ffmpeg.exe'], { 'C:/123': ['ffmpeg-x'] })
    expect(resolveBin('ffmpeg', { deps: d, roots: ['C:/123'], pathEnv: 'C:/tools' })).toBe('C:/tools/ffmpeg.exe')
  })
  it('随包的那份仍然最优先', () => {
    const d = deps(['R/ffmpeg/bin/ffmpeg.exe', 'C:/tools/ffmpeg.exe'], { R: ['ffmpeg'] })
    expect(resolveBin('ffmpeg', { deps: d, bundledRoot: 'R', roots: [], pathEnv: 'C:/tools' })).toBe('R/ffmpeg/bin/ffmpeg.exe')
  })
})
