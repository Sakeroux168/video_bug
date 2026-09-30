import { open, unlink } from 'node:fs/promises'
import { openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { CsvExportResult } from '../shared/types'

function safeName(raw: string, csvOnly = false): string {
  let name = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim()
  if (!name) name = '导出.csv'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
  if (csvOnly && !name.toLowerCase().endsWith('.csv')) name += '.csv'
  const ext = extname(name)
  return name.slice(0, name.length - ext.length).slice(0, 160) + ext.slice(0, 20)
}

function numberedName(name: string, n: number): string {
  if (n === 0) return name
  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}

export function exportFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return '下载文件夹空间不足，请腾出空间后再导出'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限写入下载文件夹，请检查文件夹权限后重试'
  return '无法把文件保存到下载文件夹，请检查文件夹是否可用、磁盘空间和权限后重试'
}

/** wx 独占创建，序号选择和写入之间不存在覆盖已有文件的窗口。 */
export async function writeCsvToDownloads(downloadsDir: string, input: unknown): Promise<CsvExportResult> {
  if (!input || typeof input !== 'object' || typeof (input as { csv?: unknown }).csv !== 'string' ||
      typeof (input as { fileName?: unknown }).fileName !== 'string' || !(input as { fileName: string }).fileName.trim()) {
    return { ok: false, error: '导出数据不完整，请重新导出' }
  }
  const { csv, fileName } = input as { csv: string; fileName: string }
  const name = safeName(fileName, true)
  for (let n = 0; n < 10000; n++) {
    const actualName = numberedName(name, n)
    const path = join(downloadsDir, actualName)
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path, 'wx') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      return { ok: false, error: exportFailure(error) }
    }
    try {
      try { await handle.writeFile('\uFEFF' + csv.replace(/^\uFEFF+/, ''), 'utf8') }
      finally { await handle.close() }
      return { ok: true, fileName: actualName, path }
    } catch (error) {
      // 只清理本次独占创建的文件，不留下半张表，也不碰已有文件。
      await unlink(path).catch(() => {})
      return { ok: false, error: exportFailure(error) }
    }
  }
  return { ok: false, error: '同名导出文件太多，请清理下载文件夹后重试' }
}

export function revealExportFile(downloadsDir: string, path: unknown, show: (path: string) => void): { ok: boolean; error?: string } {
  if (typeof path !== 'string' || dirname(resolve(path)) !== resolve(downloadsDir) || extname(path).toLowerCase() !== '.csv') {
    return { ok: false, error: '无法找到这份导出表，请重新导出后再打开' }
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a file')
    show(path)
    return { ok: true }
  } catch {
    return { ok: false, error: '导出的文件可能已被移动或删除，请检查下载文件夹' }
  }
}

/** 只接管主窗口发起的遗留下载，不注册到平台浏览器的独立 session。 */
export function installDownloadFallback(contents: WebContents, downloadsDir: () => string): void {
  contents.session.on('will-download', (_event, item, source) => {
    if (source !== contents) return
    let reserved: string | undefined
    try {
      const name = safeName(item.getFilename())
      const dir = downloadsDir()
      for (let n = 0; n < 10000; n++) {
        const path = join(dir, numberedName(name, n))
        try {
          const fd = openSync(path, 'wx')
          reserved = path
          closeSync(fd)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      if (!reserved) throw new Error('too many files')
      const path = reserved
      // Electron 要求在 will-download 回调返回之前设置，不能 await。
      item.setSavePath(path)
      item.once('done', (_doneEvent, state) => {
        if (state !== 'completed') {
          try { unlinkSync(path) } catch { /* 已不存在 */ }
          contents.send('evt:task:notice', { text: '导出未完成，请重新导出' })
        }
      })
    } catch (error) {
      item.cancel()
      if (reserved) { try { unlinkSync(reserved) } catch { /* 已不存在 */ } }
      contents.send('evt:task:notice', { text: exportFailure(error) })
    }
  })
}
