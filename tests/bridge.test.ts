import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'fs'
import type { Server } from 'http'
import { initDb, createTask } from '../src/main/db'

// R18：本机 HTTP 口（给百家号发布助手指挥抓视频）。和 ipc 的 task:create 走同一条 createTaskChecked：
// 作者链接归一化成 sec_uid、已 done 的作者去重、入库 + 入队。只绑 127.0.0.1。

const mockPaths = vi.hoisted(() => ({ userData: process.cwd() + '/.tmp-bridge-test' }))

vi.mock('electron', () => ({
  app: { getPath: () => mockPaths.userData, getAppPath: () => '' },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} }
}))

import { startBridge, jobFromBody } from '../src/main/bridge'

const AUTHOR_URL = 'https://www.douyin.com/user/abc'

let db: DatabaseSync
let server: Server | null = null
let base = ''
let enqueued: number[] = []

beforeEach(async () => {
  mkdirSync(mockPaths.userData, { recursive: true })
  db = new DatabaseSync(':memory:')
  initDb(db)
  enqueued = []
  const r = await startBridge({ db, enqueueTask: id => enqueued.push(id), isRunning: () => false, port: 0 })
  expect(r).not.toBeNull()
  server = r!.server
  base = `http://127.0.0.1:${r!.port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  rmSync(mockPaths.userData, { recursive: true, force: true })
})

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

describe('bridge', () => {
  it('GET /status：ok + 运行状态 + 聚合统计 + 任务列表', async () => {
    const res = await fetch(base + '/status')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.app).toBe('video-scraper')
    expect(j.running).toBe(false)
    expect(j.stats.tasks.total).toBe(0)
    expect(j.tasks).toEqual([])
  })

  it('POST /job：作者主页链接 → 建任务、归一化成 sec_uid、入队；GET /job/<id> 能查', async () => {
    const r = await post('/job', { query: AUTHOR_URL, targetCount: 7 })
    expect(r.status).toBe(200)
    expect(r.json.skipped).toBe(false)
    expect(typeof r.json.id).toBe('number')
    expect(enqueued).toEqual([r.json.id])
    const g = await fetch(`${base}/job/${r.json.id}`)
    expect(g.status).toBe(200)
    const j = await g.json()
    expect(j.task.type).toBe('author')
    expect(j.task.query).toBe('abc')
    expect(j.task.target_count).toBe(7)
    expect(j.task.status).toBe('pending')
    expect(j.stats.total).toBe(0)
  })

  it('POST /job：已爬过（done）的作者默认跳过，allowDuplicateAuthor=true 放行', async () => {
    const id = createTask(db, {
      platform: 'douyin', type: 'author', query: AUTHOR_URL,
      filters: { timeRange: 'all', duration: 'all', targetCount: 5 }, aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
    })
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id)
    const r1 = await post('/job', { query: AUTHOR_URL })
    expect(r1.json.skipped).toBe(true)
    expect(r1.json.reason).toContain('已爬取过')
    expect(enqueued).toEqual([])
    const r2 = await post('/job', { query: AUTHOR_URL, allowDuplicateAuthor: true })
    expect(r2.json.skipped).toBe(false)
    expect(enqueued).toHaveLength(1)
  })

  it('POST /job：坏参数 400（空 query / 认不出的链接 / 不是 JSON），未知路径 404', async () => {
    expect((await post('/job', {})).status).toBe(400)
    expect((await post('/job', { query: 'x', targetCount: 0 })).status).toBe(400)
    const short = await post('/job', { query: 'https://v.douyin.com/abc' })
    expect(short.status).toBe(200)
    expect(short.json.skipped).toBe(true)
    const bad = await fetch(base + '/job', { method: 'POST', body: '{not json' })
    expect(bad.status).toBe(400)
    expect((await fetch(base + '/nothing')).status).toBe(404)
    expect((await fetch(base + '/job/999')).status).toBe(404)
  })

  it('POST /job 带 startDate/endDate → filters 变成 custom 日期段；格式不对 400', async () => {
    const r = await post('/job', { query: AUTHOR_URL, startDate: '2026-09-10', endDate: '2026-09-27' })
    expect(r.json.skipped).toBe(false)
    const g = await (await fetch(`${base}/job/${r.json.id}`)).json()
    const f = JSON.parse(g.task.filters)
    expect(f.timeRange).toBe('custom')
    expect(f.startDate).toBe('2026-09-10')
    expect(f.endDate).toBe('2026-09-27')
    expect((await post('/job', { query: AUTHOR_URL, allowDuplicateAuthor: true, startDate: '9.10' })).status).toBe(400)
    expect((await post('/job', { query: AUTHOR_URL, allowDuplicateAuthor: true, startDate: '2026-09-28', endDate: '2026-09-27' })).status).toBe(400)
    const only = jobFromBody({ query: 'u', startDate: '2026-09-10' })
    if (typeof only !== 'string') {
      expect(only.filters.timeRange).toBe('custom')
      expect(only.filters.endDate).toBe(new Date().toISOString().slice(0, 10))
    } else {
      expect(only).toBe('')
    }
  })

  it('R19 POST /job 带 outputDir → 任务记下下载文件夹；GET /job 和 /status 看得到', async () => {
    const dir = process.platform === 'win32' ? 'Z:\\AAA\\自动发\\奶龙\\暂存' : '/tmp/奶龙/暂存'
    const r = await post('/job', { query: AUTHOR_URL, targetCount: 3, outputDir: dir })
    expect(r.status).toBe(200)
    const g = await (await fetch(`${base}/job/${r.json.id}`)).json()
    expect(g.task.output_dir).toBe(dir)
    const s = await (await fetch(base + '/status')).json()
    expect(s.features).toContain('outputDir')
  })

  it('R19 outputDir 不是完整路径 → 400;不给就用设置里的下载目录', async () => {
    const r = await post('/job', { query: AUTHOR_URL, outputDir: '暂存' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/outputDir/)
    const ok = await post('/job', { query: AUTHOR_URL, allowDuplicateAuthor: true })
    const g = await (await fetch(`${base}/job/${ok.json.id}`)).json()
    expect(g.task.output_dir ?? null).toBeNull()
    const i = jobFromBody({ query: AUTHOR_URL, outputDir: '' })
    expect(typeof i === 'string' ? i : i.outputDir).toBeUndefined()
  })

  it('jobFromBody：默认 author/douyin/5 条/自动下载；关键词任务也能建', () => {
    const a = jobFromBody({ query: ' u ' })
    expect(typeof a).not.toBe('string')
    if (typeof a !== 'string') {
      expect(a.type).toBe('author')
      expect(a.platform).toBe('douyin')
      expect(a.filters.targetCount).toBe(5)
      expect(a.autoDownload).toBe(true)
      expect(a.query).toBe('u')
    }
    const k = jobFromBody({ query: '美食', type: 'keyword', targetCount: 20, autoDownload: false })
    if (typeof k !== 'string') {
      expect(k.type).toBe('keyword')
      expect(k.autoDownload).toBe(false)
    }
    expect(typeof jobFromBody({ query: 'x', type: 'video' })).toBe('string')
    expect(typeof jobFromBody({ query: 'x', targetCount: 99999 })).toBe('string')
  })
})
