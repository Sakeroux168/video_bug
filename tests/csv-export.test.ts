import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
import { writeCsvToDownloads, revealExportFile, installDownloadFallback, exportFailure } from '../src/main/csvExport'

const dirs: string[] = []
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'csv-export-')); dirs.push(dir); return dir }
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })

describe('CSV 写入系统下载文件夹', () => {
  it('中文 UTF-8 BOM、返回实际位置，连续及并发重名都不覆盖', async () => {
    const dir = temp()
    const input = { fileName: '视频数据-2026-09-30.csv', csv: '作者,标题\r\n张三,中文作品' }
    writeFileSync(join(dir, input.fileName), '已有文件')
    const results = await Promise.all(Array.from({ length: 3 }, () => writeCsvToDownloads(dir, input)))
    expect(readFileSync(join(dir, input.fileName), 'utf8')).toBe('已有文件')
    expect(results.map(r => r.ok && r.fileName).sort()).toEqual([1, 2, 3].map(n => `视频数据-2026-09-30 (${n}).csv`))
    for (const result of results) {
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      const bytes = readFileSync(result.path)
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      expect(bytes.toString('utf8')).toBe('\uFEFF' + input.csv)
      expect(result.path).toBe(join(dir, result.fileName))
    }
  })
  it('已有 BOM 只保留一个；文件名不能逃出下载目录', async () => {
    const dir = temp()
    const result = await writeCsvToDownloads(dir, { fileName: '../作者表.csv', csv: '\uFEFF中文' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe(join(dir, result.fileName))
      expect(result.fileName).not.toMatch(/[\\/]/)
      expect(readFileSync(result.path, 'utf8')).toBe('\uFEFF中文')
    }
  })
  it('下载位置不可写时返回大白话，不报告成功', async () => {
    const dir = temp()
    const file = join(dir, '不是文件夹')
    writeFileSync(file, '')
    const result = await writeCsvToDownloads(file, { fileName: '作者表.csv', csv: '中文' })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/下载文件夹.*无法|无法.*下载文件夹/) })
    expect(readdirSync(dir)).toEqual(['不是文件夹'])
  })
  it('无效请求返回可读错误', async () => {
    expect(await writeCsvToDownloads(temp(), null)).toEqual({ ok: false, error: expect.stringMatching(/导出数据/) })
  })
  it('权限不足和写到一半磁盘满都不返回成功，关闭文件并清理半成品', async () => {
    const dir = temp(), input = { fileName: '作者表.csv', csv: '中文' }
    const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
    const spy = vi.mocked(fsPromises.open)
    spy.mockRejectedValueOnce(Object.assign(new Error('access'), { code: 'EACCES' }))
    expect(await writeCsvToDownloads(dir, input)).toEqual({ ok: false, error: expect.stringMatching(/没有权限.*下载文件夹/) })
    const handle = await originalOpen(join(dir, input.fileName), 'wx')
    await handle.writeFile('半张表')
    const close = vi.spyOn(handle, 'close')
    vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }))
    spy.mockResolvedValueOnce(handle)
    expect(await writeCsvToDownloads(dir, input)).toEqual({ ok: false, error: expect.stringMatching(/空间不足/) })
    expect(close).toHaveBeenCalledOnce()
    expect(readdirSync(dir)).toEqual([])
    expect(exportFailure({ code: 'EPERM' })).toMatch(/没有权限/)
  })
  it('打开所在文件夹只允许下载目录中存在的 CSV', async () => {
    const dir = temp(), show = vi.fn()
    const result = await writeCsvToDownloads(dir, { fileName: '作者表.csv', csv: '中文' })
    if (!result.ok) throw new Error(result.error)
    expect(revealExportFile(dir, result.path, show)).toEqual({ ok: true })
    expect(show).toHaveBeenCalledWith(result.path)
    expect(revealExportFile(dir, join(dir, '..', 'other.csv'), show).ok).toBe(false)
    expect(revealExportFile(dir, join(dir, '消失.csv'), show).ok).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('主窗口遗留下载兜底', () => {
  it('同步设置保存路径，重名加号；不处理其他窗口/分区的下载，取消清理占位文件', () => {
    const dir = temp(), session = new EventEmitter()
    const contents = { session, send: vi.fn() }
    installDownloadFallback(contents as never, () => dir)
    const makeItem = () => Object.assign(new EventEmitter(), { getFilename: () => '作者表.csv', setSavePath: vi.fn(), cancel: vi.fn() })
    const foreign = makeItem()
    session.emit('will-download', {}, foreign, { session: new EventEmitter() })
    expect(foreign.setSavePath).not.toHaveBeenCalled()
    writeFileSync(join(dir, '作者表.csv'), '已有')
    const first = makeItem(), second = makeItem()
    session.emit('will-download', {}, first, contents)
    session.emit('will-download', {}, second, contents)
    expect(first.setSavePath).toHaveBeenCalledWith(join(dir, '作者表 (1).csv'))
    expect(second.setSavePath).toHaveBeenCalledWith(join(dir, '作者表 (2).csv'))
    first.emit('done', {}, 'cancelled')
    expect(readdirSync(dir).sort()).toEqual(['作者表 (2).csv', '作者表.csv'].sort())
    expect(readFileSync(join(dir, '作者表.csv'), 'utf8')).toBe('已有')
  })
  it('写入失败取消下载并提示，不能退回系统保存框', () => {
    const session = new EventEmitter(), contents = { session, send: vi.fn() }
    const dir = temp(), file = join(dir, '不是文件夹')
    writeFileSync(file, '')
    installDownloadFallback(contents as never, () => file)
    const item = { getFilename: () => '作者表.csv', setSavePath: vi.fn(), cancel: vi.fn() }
    session.emit('will-download', {}, item, contents)
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(contents.send).toHaveBeenCalledWith('evt:task:notice', { text: expect.stringMatching(/下载文件夹/) })
  })
})
