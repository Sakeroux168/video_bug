import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'fs'
import type { Server } from 'http'
import { initDb } from '../src/main/db'

// detailMode（safe/fast）经本机接口 POST /job 传入并随 filters JSON 落库

const mockPaths = vi.hoisted(() => ({ userData: process.cwd() + '/.tmp-bridge-mode-test' }))

vi.mock('electron', () => ({
  app: { getPath: () => mockPaths.userData, getAppPath: () => '' },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} }
}))

import { startBridge, jobFromBody } from '../src/main/bridge'
import type { CreateTaskInput } from '../src/shared/types'

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

describe('POST /job 的 detailMode 参数', () => {
  it('jobFromBody：fast/safe 写进 filters；非法值返回错误说明', () => {
    const fast = jobFromBody({ query: '美食', type: 'keyword', platform: 'xiaohongshu', detailMode: 'fast' }) as CreateTaskInput
    expect(fast.filters.detailMode).toBe('fast')
    const safe = jobFromBody({ query: '美食', type: 'keyword', platform: 'xiaohongshu', detailMode: 'safe' }) as CreateTaskInput
    expect(safe.filters.detailMode).toBe('safe')
    // 不传 → 不设（调度器按稳妥处理）
    const none = jobFromBody({ query: '美食', type: 'keyword' }) as CreateTaskInput
    expect(none.filters.detailMode).toBeUndefined()
    expect(typeof jobFromBody({ query: 'u', detailMode: 'turbo' })).toBe('string')
    expect(typeof jobFromBody({ query: 'u', detailMode: 1 })).toBe('string')
  })

  it('POST /job：detailMode 落进任务 filters JSON；GET /job/<id> 可读回', async () => {
    const r = await post('/job', { query: '美食', type: 'keyword', platform: 'xiaohongshu', targetCount: 3, detailMode: 'fast' })
    expect(r.status).toBe(200)
    expect(r.json.skipped).toBe(false)
    const g = await fetch(`${base}/job/${r.json.id}`)
    const j = await g.json()
    expect(j.task.platform).toBe('xiaohongshu')
    expect(JSON.parse(j.task.filters).detailMode).toBe('fast')
  })

  it('POST /job：detailMode 非法 → 400', async () => {
    const r = await post('/job', { query: '美食', type: 'keyword', detailMode: 'turbo' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/detailMode/)
  })
})
