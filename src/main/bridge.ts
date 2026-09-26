import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { DatabaseSync } from 'node:sqlite'
import { globalStats, listTasks, taskStats } from './db'
import { createTaskChecked } from './taskCreate'
import type { CreateTaskInput, Filters } from '../shared/types'

/**
 * R18：本机 HTTP 口，给「百家号发布助手」这类外部程序指挥本程序抓视频用。
 * 只绑 127.0.0.1（不对外），不做鉴权——和发布助手自己的 agent 桥一个思路：同一台机器上的程序互相调。
 *
 *   GET  /status          → { ok, app, running, stats, tasks: 最近 50 个任务 }
 *   POST /job             → body { query, targetCount?, type?, platform?, autoDownload?, allowDuplicateAuthor? }
 *                            → { id, skipped, reason? }（和界面上建任务走同一条检查：归一化 + 作者去重）
 *   GET  /job/<id>        → { task, stats }
 *
 * 默认端口 47321（settings.bridgePort），settings.bridgeEnabled=false 关掉。
 */
export interface BridgeDeps {
  db: DatabaseSync
  enqueueTask: (id: number) => void
  isRunning: () => boolean
  port: number
  host?: string
}

export const DEFAULT_BRIDGE_PORT = 47321
const MAX_BODY = 64 * 1024

export interface JobBody {
  query?: unknown
  targetCount?: unknown
  type?: unknown
  platform?: unknown
  autoDownload?: unknown
  allowDuplicateAuthor?: unknown
}

/** 把外部程序发来的 body 变成 CreateTaskInput；不合法返回 string 说明原因。 */
export function jobFromBody(body: JobBody): CreateTaskInput | string {
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return 'query 不能为空（作者主页链接 / 关键词 / 话题）'
  const type = body.type === undefined ? 'author' : body.type
  if (type !== 'author' && type !== 'keyword' && type !== 'hashtag') return 'type 只能是 author / keyword / hashtag'
  const platform = body.platform === undefined ? 'douyin' : body.platform
  if (typeof platform !== 'string' || !platform) return 'platform 不对'
  const n = body.targetCount === undefined ? 5 : Number(body.targetCount)
  if (!Number.isFinite(n) || n < 1 || n > 5000) return 'targetCount 要在 1~5000 之间'
  const filters: Filters = { timeRange: 'all', duration: 'all', targetCount: Math.floor(n) }
  const input: CreateTaskInput = {
    platform, type, query, filters,
    aiFilterEnabled: false, aiOrganizeEnabled: false,
    autoDownload: body.autoDownload === undefined ? true : Boolean(body.autoDownload)
  }
  if (body.allowDuplicateAuthor !== undefined) input.allowDuplicateAuthor = Boolean(body.allowDuplicateAuthor)
  return input
}

function send(res: ServerResponse, code: number, data: unknown): void {
  const buf = Buffer.from(JSON.stringify(data), 'utf-8')
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export function handleRequest(deps: BridgeDeps, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  void (async () => {
    try {
      if (req.method === 'GET' && path === '/status') {
        send(res, 200, {
          ok: true, app: 'video-scraper', running: deps.isRunning(),
          stats: globalStats(deps.db), tasks: listTasks(deps.db).slice(0, 50)
        })
        return
      }
      if (req.method === 'POST' && path === '/job') {
        let body: JobBody
        try { body = JSON.parse((await readBody(req)) || '{}') as JobBody } catch { send(res, 400, { error: 'body 不是 JSON' }); return }
        const input = jobFromBody(body)
        if (typeof input === 'string') { send(res, 400, { error: input }); return }
        send(res, 200, createTaskChecked(deps.db, input, deps.enqueueTask))
        return
      }
      const m = /^\/job\/(\d+)$/.exec(path)
      if (req.method === 'GET' && m) {
        const id = Number(m[1])
        const task = listTasks(deps.db).find(t => t.id === id) ?? null
        if (!task) { send(res, 404, { error: '没有这个任务' }); return }
        send(res, 200, { task, stats: taskStats(deps.db, id) })
        return
      }
      send(res, 404, { error: '只有 GET /status、POST /job、GET /job/<id>' })
    } catch (e) {
      send(res, 500, { error: String((e as Error)?.message ?? e) })
    }
  })()
}

/** 起服务；端口被占等错误只打日志不影响主程序。resolve 实际端口（port=0 时系统分配，测试用）。 */
export function startBridge(deps: BridgeDeps): Promise<{ server: Server; port: number } | null> {
  return new Promise(resolve => {
    const server = createServer((req, res) => handleRequest(deps, req, res))
    server.on('error', (e: Error) => {
      console.log('[桥接] 本机接口没起来:', e.message)
      resolve(null)
    })
    server.listen(deps.port, deps.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : deps.port
      console.log(`[桥接] 本机接口已开: http://127.0.0.1:${port}  (GET /status, POST /job, GET /job/<id>)`)
      resolve({ server, port })
    })
  })
}
