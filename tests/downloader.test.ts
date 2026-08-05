import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus } from '../src/main/db'
import { Downloader, buildUserAgent } from '../src/main/downloader'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'dl-'))
})

afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false,
  autoDownload: true
}
const item = (awemeId = 'AW001'): VideoItem => ({
  awemeId, title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', durationSec: 10, publishTime: 1710000000, likes: 0
})

describe('buildUserAgent', () => {
  it('包含桌面浏览器标识', () => {
    expect(buildUserAgent('douyin')).toMatch(/Mozilla/)
  })
})

describe('Downloader', () => {
  it('下载成功：写文件、更新状态 done', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)

    // 合法 MP4 文件头（含 ftyp box），否则下载器会判定为坏文件
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)

    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain('cdn.test')
      return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch

    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    const events: string[] = []
    dl.onEvent(e => events.push(`${e.type}:${e.status}`))
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(row.local_path).toBeTruthy()
    expect(existsSync(row.local_path!)).toBe(true)
    expect(readFileSync(row.local_path!)).toEqual(mp4)
    expect(events).toContain('video:status:done')
  })

  it('下载内容是坏文件（无 ftyp）→ 标记 failed + parse_error，删除坏文件', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('parse_error')
  })

  it('HTTP 500 首次触发网络重试：pending + retry_count=1，5s 后重新入队', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('pending') // 等待 5s 重试，未直接失败
    expect(row.retry_count).toBe(1)
    expect(row.error).toBeNull()
  })

  it('网络错误重试耗尽（第3次）→ failed + 错误码 network', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET retry_count=2 WHERE id=?').run(v.id) // 已重试2次，本次为第3次
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network')
    expect(row.retry_count).toBe(3)
  })

  it('地址过期（超过 TTL）→ failed + 错误码 address_expired，不再发起下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    db.prepare('UPDATE videos SET fetched_at=? WHERE id=?').run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), v.id)
    const fetchImpl = (async () => { throw new Error('不应发起下载请求') }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('address_expired')
  })

  it('磁盘错误（ENOENT）→ 直接 failed + 错误码 disk，不重试', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => {
      const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed') // 磁盘错误不进入 5s 重试，直接失败
    expect(row.error).toBe('disk')
    expect(row.retry_count).toBe(1)
  })

  it('pause 后入队不被下载（fetch 不调用），resume 后执行', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    const fetchImpl = (async () => { fetchCount++; return new Response(mp4, { status: 200 }) }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.pause()
    expect(dl.isPaused()).toBe(true)
    dl.enqueue(v.id)
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(0) // 暂停中 drain 不拉取
    dl.resume()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(1)
  })

  it('cancel 在途：fetch 收到 abort signal，状态 cancelled，不走网络重试', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    let fetchStarted!: () => void
    const started = new Promise<void>(res => { fetchStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞在 abort 上
    dl.cancel([v.id])
    await new Promise(r => setTimeout(r, 30)) // 等 abort 传播、runOne 收尾
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    expect(row.retry_count).toBe(0) // 不走 5s 网络重试，retry_count 不增
  })

  it('cancel 排队项：队列中 pending 移除并标 cancelled，不再下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [v1, v2] = listVideos(db, taskId)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      firstStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started
    expect(fetchCount).toBe(1) // v2 尚未开始
    dl.cancel([v2.id])
    await new Promise(r => setTimeout(r, 20))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v2.id)!.status).toBe('cancelled')
    expect(fetchCount).toBe(1) // v2 被移出队列，不再下载
    dl.cancel([v1.id]) // 清理在途，避免悬挂 promise
    await new Promise(r => setTimeout(r, 20))
  })

  it('download([collected]) → 状态 pending 并下载成功 done', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    setVideoStatus(db, v.id, 'collected') // 手动模式：入 collected 等待手动下载
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    const fetchImpl = (async () => new Response(mp4, { status: 200 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.download([v.id])
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
  })

  it('网络重试回退窗口内 cancel → 清定时器，5s 后不再重新下载', async () => {
    // 只伪造 setTimeout/clearTimeout，避免影响 Date/微任务
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const taskId = createTask(db, input)
      insertVideos(db, [item()], taskId, 'douyin')
      const [v] = listVideos(db, taskId)
      let fetchCount = 0
      const fetchImpl = (async () => { fetchCount++; return new Response('err', { status: 500 }) }) as typeof fetch
      const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
      dl.enqueue(v.id)
      dl.start()
      // 让第一次下载(500)跑完 → 进入 5s 网络重试回退（status=pending, retry_count=1）
      await vi.advanceTimersByTimeAsync(0)
      let row = listVideos(db, taskId)[0]
      expect(row.status).toBe('pending')
      expect(row.retry_count).toBe(1)
      // 回退窗口内取消：应清掉定时器
      dl.cancel([v.id])
      await vi.advanceTimersByTimeAsync(6000) // 超过 5s 回退窗口
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('cancelled') // 未被重新下载
      expect(fetchCount).toBe(1) // 定时器被清，不再发起 fetch
    } finally {
      vi.useRealTimers()
    }
  })

  it('全局 pause 中断在途：fetch 收到 abort，状态回 pending，resume 后重新下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) { // 第一次在途阻塞，等 abort；之后的调用直接成功
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞在 abort 上
    dl.pause() // 全局暂停：应中断在途
    await new Promise(r => setTimeout(r, 30))
    let row = listVideos(db, taskId)[0]
    expect(row.status).toBe('pending') // 全局暂停中断 → 回 pending（非 cancelled）
    expect(row.error).toBeNull()
    expect(fetchCount).toBe(1) // 暂停中不重新拉取
    dl.resume()
    await new Promise(r => setTimeout(r, 50))
    row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done') // resume 后重新下载成功
    expect(fetchCount).toBe(2)
  })

  it('单条 pause 在途：中断标 paused（区别于全局暂停的 pending 与取消的 cancelled），resumeVideo 后恢复', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pauseVideo([v.id]) // 单条暂停在途
    await new Promise(r => setTimeout(r, 30))
    let row = listVideos(db, taskId)[0]
    expect(row.status).toBe('paused')
    expect(row.error).toBeNull()
    expect(fetchCount).toBe(1) // 暂停后不重新拉取
    dl.resumeVideo([v.id]) // 单条继续
    await new Promise(r => setTimeout(r, 50))
    row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(2)
  })

  it('单条 pause 排队项：移出队列标 paused，不再下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [v1, v2] = listVideos(db, taskId)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      firstStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started
    expect(fetchCount).toBe(1) // v2 尚未开始
    dl.pauseVideo([v2.id])
    await new Promise(r => setTimeout(r, 20))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v2.id)!.status).toBe('paused')
    expect(fetchCount).toBe(1) // 移出队列，不再下载
    dl.cancel([v1.id]) // 清理在途，避免悬挂 promise
    await new Promise(r => setTimeout(r, 20))
  })

  it('AbortError 路由：全局暂停中断后若被 cancel 抢先 → 保持 cancelled 不再重排', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      firstStarted()
      const signal = init?.signal!
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
      })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pause() // 全局暂停中断在途
    dl.cancel([v.id]) // 中断后立刻取消：应优先于重排
    await new Promise(r => setTimeout(r, 30))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('cancelled')
    dl.resume()
    await new Promise(r => setTimeout(r, 30))
    expect(fetchCount).toBe(1) // 未被重新下载
  })

  it('全局 resume 同时恢复单条暂停项（清空 pausedIds）', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item('A'), item('B')], taskId, 'douyin')
    const [v1, v2] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })))
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    // 并发=1：v1 在途阻塞，v2 只能排队
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 1, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v1.id)
    dl.enqueue(v2.id)
    await started // v1 在途阻塞
    dl.pauseVideo([v2.id]) // 单条暂停排队项 v2
    expect(listVideos(db, taskId).find(r => r.id === v2.id)!.status).toBe('paused')
    dl.pause() // 全局暂停（中断 v1）
    await new Promise(r => setTimeout(r, 30))
    expect(listVideos(db, taskId).find(r => r.id === v1.id)!.status).toBe('pending')
    dl.resume() // 全局继续：v1 重新下载，单条暂停的 v2 也一并恢复
    await new Promise(r => setTimeout(r, 80))
    const rows = listVideos(db, taskId)
    expect(rows.find(r => r.id === v1.id)!.status).toBe('done')
    expect(rows.find(r => r.id === v2.id)!.status).toBe('done')
    expect(fetchCount).toBe(3) // v1(中断) + v1(重下) + v2
  })

  it('单条 pause 后立即全局 resume：延迟 abort 回调不误标 cancelled，恢复下载', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        // 模拟写盘路径经 stream/fs macrotask 传播的延迟：abort 后 50ms 才抛 AbortError
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), 50)
          })
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started // fetch 已发起并阻塞
    dl.pauseVideo([v.id]) // 单条暂停在途：abort 已发，回调 50ms 后才落定
    dl.resume() // 期间全局继续：清空 pausedIds，abort 回调此时尚未执行
    await new Promise(r => setTimeout(r, 150)) // 等延迟回调落定 + 重新下载完成
    const row = listVideos(db, taskId)[0]
    expect(row.status).not.toBe('cancelled') // 不能因回调迟到被误标取消
    expect(row.status).toBe('done') // 已回队恢复，drain 续下
    expect(fetchCount).toBe(2)
  })

  it('全局 pause 后立即 resume：延迟 abort 回调不误标 cancelled，pending 回队续下', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const mp4 = Buffer.alloc(2048)
    mp4.writeUInt32BE(0x18, 0)
    mp4.write('ftypisom', 4)
    let fetchCount = 0
    let firstStarted!: () => void
    const started = new Promise<void>(res => { firstStarted = res })
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        firstStarted()
        const signal = init?.signal!
        // 同上：模拟 abort 事件经 macrotask 延迟传播
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), 50)
          })
        })
      }
      return new Response(mp4, { status: 200 })
    }) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl, { validator: async () => true })
    dl.enqueue(v.id)
    dl.start()
    await started
    dl.pause() // 全局暂停：中断在途
    dl.resume() // 在 abort 回调落定前已恢复
    await new Promise(r => setTimeout(r, 150))
    const row = listVideos(db, taskId)[0]
    expect(row.status).not.toBe('cancelled') // 不能因回调迟到被误标取消
    expect(row.status).toBe('done')
    expect(fetchCount).toBe(2)
  })

  it('网络重试回退窗口内单条 pause → 清定时器，5s 后不再重新下载', async () => {
    // 只伪造 setTimeout/clearTimeout，避免影响 Date/微任务
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const taskId = createTask(db, input)
      insertVideos(db, [item()], taskId, 'douyin')
      const [v] = listVideos(db, taskId)
      let fetchCount = 0
      const fetchImpl = (async () => { fetchCount++; return new Response('err', { status: 500 }) }) as typeof fetch
      const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
      dl.enqueue(v.id)
      dl.start()
      // 让第一次下载(500)跑完 → 进入 5s 网络重试回退（status=pending, retry_count=1）
      await vi.advanceTimersByTimeAsync(0)
      let row = listVideos(db, taskId)[0]
      expect(row.status).toBe('pending')
      expect(row.retry_count).toBe(1)
      // 回退窗口内单条暂停：应清掉定时器并标 paused
      dl.pauseVideo([v.id])
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('paused')
      await vi.advanceTimersByTimeAsync(6000) // 超过 5s 回退窗口
      row = listVideos(db, taskId)[0]
      expect(row.status).toBe('paused') // 定时器被清，未被重新下载
      expect(fetchCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
