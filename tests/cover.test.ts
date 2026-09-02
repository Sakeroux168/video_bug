import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coverExtension, downloadCover } from '../src/main/cover'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cover-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('coverExtension', () => {
  it.each([
    ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
    ['IMAGE/WEBP; charset=binary', '.webp'], ['application/octet-stream', '.jpg'], [null, '.jpg']
  ])('%s → %s', (contentType, expected) => {
    expect(coverExtension(contentType)).toBe(expected)
  })
})

describe('downloadCover', () => {
  const headers = { 'user-agent': 'test', referer: 'https://www.douyin.com/' }

  it('按 Content-Type 保存完成文件并返回路径', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = (async () => new Response(bytes, {
      status: 200, headers: { 'content-type': 'image/webp' }
    })) as typeof fetch
    const path = await downloadCover({
      url: 'https://img.test/c', dir, stem: '标题', fetchImpl,
      signal: new AbortController().signal, headers
    })
    expect(path).toBe(join(dir, '标题.webp'))
    expect(readFileSync(path!)).toEqual(Buffer.from(bytes))
  })

  it('响应失败或无正文时返回 null，不留文件', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch
    expect(await downloadCover({
      url: 'https://img.test/missing', dir, stem: '标题', fetchImpl,
      signal: new AbortController().signal, headers
    })).toBeNull()
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('流读取失败时删除 .cover.part 并返回 null', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.error(new Error('stream failed'))
      }
    })
    const fetchImpl = (async () => new Response(stream, {
      status: 200, headers: { 'content-type': 'image/png' }
    })) as typeof fetch
    expect(await downloadCover({
      url: 'https://img.test/broken', dir, stem: '标题', fetchImpl,
      signal: new AbortController().signal, headers
    })).toBeNull()
    expect(existsSync(join(dir, '标题.cover.part'))).toBe(false)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('中止时清理半成品并向上抛出，让下载器执行暂停/取消状态转换', async () => {
    const aborter = new AbortController()
    aborter.abort()
    const fetchImpl = (async () => { throw new Error('aborted') }) as typeof fetch
    await expect(downloadCover({
      url: 'https://img.test/slow', dir, stem: '标题', fetchImpl,
      signal: aborter.signal, headers
    })).rejects.toThrow('aborted')
    expect(readdirSync(dir)).toHaveLength(0)
  })
})
