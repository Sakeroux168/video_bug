import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CsvExportResult } from '../src/shared/types'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), getPath: vi.fn((_name: string) => process.cwd()), showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: electron.getPath },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn), on: vi.fn() },
  shell: { showItemInFolder: electron.showItemInFolder }, dialog: {}, clipboard: {}
}))
import { registerIpc } from '../src/main/ipc'

const dirs: string[] = []
afterEach(() => { vi.clearAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
it('IPC 实际使用系统 downloads 路径，定位交给 shell，不打开保存对话框', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipc-csv-')); dirs.push(dir)
  electron.getPath.mockImplementation(name => { if (name !== 'downloads') throw new Error('unexpected path'); return dir })
  registerIpc({} as never)
  const result = await electron.handlers.get('csv:export')!(null, { csv: '作者\r\n张三', fileName: '作者表.csv' }) as CsvExportResult
  if (!result.ok) throw new Error(result.error)
  expect(result.path).toBe(join(dir, '作者表.csv'))
  expect(readFileSync(result.path, 'utf8')).toBe('\uFEFF作者\r\n张三')
  expect(electron.handlers.get('csv:reveal')!(null, result.path)).toEqual({ ok: true })
  expect(electron.showItemInFolder).toHaveBeenCalledWith(result.path)
  expect(electron.getPath).toHaveBeenCalledWith('downloads')
})
it('系统路径获取失败也返回中文错误，IPC 不抛异常', async () => {
  electron.getPath.mockImplementation(() => { throw new Error('path unavailable') })
  registerIpc({} as never)
  expect(await electron.handlers.get('csv:export')!(null, { csv: '中文', fileName: '作者表.csv' })).toEqual({ ok: false, error: expect.stringMatching(/下载文件夹/) })
})
