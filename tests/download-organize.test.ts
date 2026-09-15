import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb, createTask, insertVideos, listVideos } from '../src/main/db'
import { Downloader } from '../src/main/downloader'
import { Organizer, ALL_ORGANIZE_LEVELS } from '../src/main/organizer'
import { scanFilesTree } from '../src/main/fileManager'
import { deleteVideoRows } from '../src/main/videoDelete'

describe('下载 → 封面 → 方向归档 → 删除联动', () => {
  it('本机 HTTP 资源流经真实下载与归档模块，两种方向成对落盘且封面不计入视频数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paired-flow-'))
    const db = new DatabaseSync(':memory:')
    const videoBytes = Buffer.alloc(2048)
    videoBytes.write('ftypisom', 4)
    const coverBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
    const server = createServer((req, res) => {
      const isImage = req.url?.endsWith('.png')
      res.writeHead(200, { 'content-type': isImage ? 'image/png' : 'video/mp4' })
      res.end(isImage ? coverBytes : videoBytes)
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      const base = `http://127.0.0.1:${port}`
      initDb(db)
      const taskId = createTask(db, {
        platform: 'douyin', type: 'keyword', query: '美食',
        filters: { timeRange: 'all', duration: 'all', targetCount: 2 },
        aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
      })
      insertVideos(db, [
        { awemeId: 'VERTICAL', width: 1080, height: 1920, durationSec: 20 },
        { awemeId: 'HORIZONTAL', width: 1920, height: 1080, durationSec: 65 }
      ].map(v => ({
        ...v, title: v.awemeId, authorSecUid: 'PAIR_AUTHOR', authorNickname: '联动作者',
        authorHomeUrl: 'https://www.douyin.com/user/PAIR_AUTHOR',
        playUrl: `${base}/${v.awemeId}.mp4`, coverUrl: `${base}/${v.awemeId}.png`,
        publishTime: 1710000000, likes: 0
      })), taskId, 'douyin')
      const org = new Organizer({ db, downloadDir: dir, levels: ALL_ORGANIZE_LEVELS, resolveCategory: async () => '美食' })
      // 本测试验证业务流程和实际 HTTP/文件流；视频编码校验另由 asr-media 与探测测试覆盖。
      // 下载链已不再转码：成品就是原视频字节，方向由平台元数据决定。
      const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 2, addressTtlMin: 30 }, fetch, { validator: async () => true })
      dl.onEvent(event => {
        if (event.status === 'done') org.markAuthorPending(listVideos(db, taskId)[0].author_id!)
      })
      for (const row of listVideos(db, taskId)) dl.enqueue(row.id)
      await vi.waitFor(() => expect(dl.isIdle()).toBe(true), { timeout: 5000 })
      expect(listVideos(db, taskId).map(v => v.status)).toEqual(['done', 'done'])
      expect(await org.organizePending()).toBe(1)
      const rows = listVideos(db, taskId)
      for (const row of rows) {
        const expected = join(dir, '美食', '联动作者', row.video_height >= row.video_width ? '竖屏' : '横屏', row.duration <= 60 ? '一分钟内' : '一分钟外')
        expect(dirname(row.local_path!)).toBe(expected)
        expect(dirname(row.cover_path!)).toBe(expected)
        expect(row.original_path).toBeNull()
        expect(basename(row.local_path!, '.mp4')).toBe(basename(row.cover_path!, '.png'))
        expect(readdirSync(expected)).toHaveLength(2)
        expect(readFileSync(row.local_path!)).toEqual(videoBytes)
        expect(readFileSync(row.cover_path!)).toEqual(coverBytes)
      }
      expect(scanFilesTree(dir).root.videoCount).toBe(2)
      expect(scanFilesTree(dir).totalSize).toBe(videoBytes.length * 2)
      expect(await deleteVideoRows({ db, downloader: dl, downloadDir: dir }, [rows[0].id]))
        .toEqual({ ok: true, deleted: 1 })
      expect(readdirSync(dirname(rows[0].local_path!))).toHaveLength(0)
      expect(scanFilesTree(dir).root.videoCount).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
