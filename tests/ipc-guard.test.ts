import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 2026-10-06 安全检查 A2：主进程接口只认本软件主界面；「打开文件夹」只打开真实存在的文件夹
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(async () => '')
}))
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn), on: vi.fn() },
  shell: { openPath: electron.openPath, showItemInFolder: vi.fn() }, dialog: {}, clipboard: {}
}))
import { registerIpc } from '../src/main/ipc'

const dirs: string[] = []
afterEach(() => { vi.clearAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const appEvent = { senderFrame: { url: 'file:///C:/app/out/renderer/index.html' } }
const webEvent = { senderFrame: { url: 'https://www.douyin.com/search/x' } }

describe('IPC 调用方校验', () => {
  it('平台网页（或被它控制的页面）调用主进程接口 → 拒绝', async () => {
    registerIpc({} as never)
    await expect(Promise.resolve().then(() => electron.handlers.get('dialog:openDir')!(webEvent, 'C:/'))).rejects.toThrow(/主界面/)
    await expect(Promise.resolve().then(() => electron.handlers.get('csv:export')!(webEvent, { csv: 'a', fileName: 'a.csv' }))).rejects.toThrow(/主界面/)
    expect(electron.openPath).not.toHaveBeenCalled()
  })

  it('页面已销毁（senderFrame 为 null）→ 拒绝', async () => {
    registerIpc({} as never)
    await expect(Promise.resolve().then(() => electron.handlers.get('dialog:openDir')!({ senderFrame: null }, 'C:/'))).rejects.toThrow(/主界面/)
  })
})

describe('打开文件夹只打开真实存在的文件夹', () => {
  it('文件夹 → 打开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipc-guard-')); dirs.push(dir)
    registerIpc({} as never)
    await electron.handlers.get('dialog:openDir')!(appEvent, dir)
    expect(electron.openPath).toHaveBeenCalledWith(dir)
  })

  it('可执行文件 / 不存在的路径 / 非字符串 → 不打开（以前会直接运行 .exe）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipc-guard-')); dirs.push(dir)
    const exe = join(dir, 'evil.exe'); writeFileSync(exe, 'x')
    registerIpc({} as never)
    for (const p of [exe, join(dir, 'nope'), 123, '']) await electron.handlers.get('dialog:openDir')!(appEvent, p)
    expect(electron.openPath).not.toHaveBeenCalled()
  })
})
