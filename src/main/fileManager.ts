import type { DatabaseSync } from 'node:sqlite'
import type { Dirent } from 'fs'
import { readdirSync, statSync } from 'fs'
import { readdir, rm, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { deleteVideosByPathPrefix, recomputeAuthorCounts } from './db'
import { isPathInside } from './pathSafety'
import { deleteVideoRows } from './videoDelete'
import type { FileDeleteResult, FilesDirNode, FilesTree, FilesVideoFile } from '../shared/types'

export interface FileManagerDeps {
  db: DatabaseSync
  /** 下载目录：删除目标必须位于其内（路径穿越防护） */
  downloadDir: string
  /** 删单个视频时沿用 video:delete 语义先掐断在途/排队项；纯目录删除不需要，测试里可不传 */
  downloader?: { cancel(ids: number[]): void }
  /** 把文件 / 文件夹放进回收站（主进程传 shell.trashItem）；不传就直接删（单测用） */
  trash?: (path: string) => Promise<void>
}

function statExists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}

/** 隐藏/临时目录或文件（~ 或 . 开头）一律跳过，不进树也不参与统计。
 *  下载器的 .video-<id>.download.part.mp4 与视频处理页的 .video-process-*.part.mp4 都是 . 开头，天然被挡在外面。 */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~')
}

/** 保留原片（旧版转码流程 / 视频处理页备份）由成品带着走，不应在文件管理统计里被当成第二条视频。 */
export function isCountedVideo(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mp4') && !lower.endsWith('.original.mp4')
}

/** 目录/文件名按中文习惯排序，扫描结果与磁盘枚举顺序解耦，界面每次刷新顺序稳定 */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}

/**
 * 递归扫描一个目录：子目录逐个下钻，直属 .mp4 计入 files；videoCount/size 为递归合计。
 * 不给任何一层贴「品类」「作者」标签——归档层级四个开关各自可关，目录树长什么样完全由设置决定，
 * 文件管理只负责把磁盘上的结构原样呈现。目录不可读（权限/竞态）→ 当空目录处理，不中断整棵树。
 */
function scanDir(dir: string, name: string): FilesDirNode {
  const node: FilesDirNode = { name, videoCount: 0, size: 0, dirs: [], files: [] }
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return node }
  for (const e of entries) {
    if (isIgnoredName(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = scanDir(p, e.name)
      node.dirs.push(sub)
      node.videoCount += sub.videoCount
      node.size += sub.size
    } else if (e.isFile() && isCountedVideo(e.name)) {
      // 文件在统计瞬间被删（竞态）→ 按 0 字节计，不中断整次扫描
      let size = 0
      try { size = statSync(p).size } catch { /* 忽略 */ }
      const file: FilesVideoFile = { name: e.name, size }
      node.files.push(file)
      node.videoCount++
      node.size += size
    }
  }
  node.dirs.sort(byName)
  node.files.sort(byName)
  return node
}

/** 同时最多读多少个文件的大小（异步扫描用；太多会占满 libuv 线程池，拖慢下载写盘） */
const STAT_CONCURRENCY = 16

/** 和 scanDir 规则完全一样的异步版：全程走 fs.promises，扫描期间主进程照常处理下载、IPC 和计时器 */
async function scanDirAsync(dir: string, name: string, statLimit: <T>(fn: () => Promise<T>) => Promise<T>): Promise<FilesDirNode> {
  const node: FilesDirNode = { name, videoCount: 0, size: 0, dirs: [], files: [] }
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return node }
  const subdirs: Array<Promise<FilesDirNode>> = []
  const files: Array<Promise<FilesVideoFile>> = []
  for (const e of entries) {
    if (isIgnoredName(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) subdirs.push(scanDirAsync(p, e.name, statLimit))
    else if (e.isFile() && isCountedVideo(e.name)) {
      // 文件在统计瞬间被删（竞态）→ 按 0 字节计，不中断整次扫描
      files.push(statLimit(() => stat(p).then(s => s.size, () => 0)).then(size => ({ name: e.name, size })))
    }
  }
  for (const sub of await Promise.all(subdirs)) {
    node.dirs.push(sub)
    node.videoCount += sub.videoCount
    node.size += sub.size
  }
  for (const file of await Promise.all(files)) {
    node.files.push(file)
    node.videoCount++
    node.size += file.size
  }
  node.dirs.sort(byName)
  node.files.sort(byName)
  return node
}

/** 简单的并发上限：同一时间最多跑 limit 个 */
function concurrencyLimit(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try { return await fn() } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/**
 * 文件管理页 / 概览「扫描」用的异步版（ipc files:tree）。2026-10-06 性能检查 C2：
 * 同步版在 2 万个文件时一次卡住主进程 2 秒（下载、界面、任务调度全停）。结果与 scanFilesTree 完全相同。
 */
export async function scanFilesTreeAsync(downloadDir: string): Promise<FilesTree> {
  const root = await scanDirAsync(downloadDir, '', concurrencyLimit(STAT_CONCURRENCY))
  return { root, totalSize: root.size, downloadDir }
}

/**
 * 文件管理：扫描下载目录 → 通用目录树（任意层级）。
 * 根目录直属的 mp4 与子目录一视同仁地可见；隐藏/临时项（~ . 开头）跳过；
 * 目录不存在或为空 → 空根节点；totalSize = 根节点递归合计，downloadDir 回传供前端拼定位路径。
 * 纯函数（不入库、不落盘），便于单测。
 */
export function scanFilesTree(downloadDir: string): FilesTree {
  const root = scanDir(downloadDir, '')
  return { root, totalSize: root.size, downloadDir }
}

/**
 * 定位目录校验（ipc files:locate 复用）：路径穿越防护 + 目标必须是存在的目录。
 * 校验通过返回 { ok: true }，由 ipc 层再调 shell.showItemInFolder（本函数不触 shell，便于单测）。
 */
export function locateFileDir(downloadDir: string, dirPath: string): { ok: boolean; error?: string } {
  if (!isPathInside(downloadDir, dirPath)) return { ok: false, error: '非法路径：目标不在下载目录内' }
  try {
    if (!statSync(dirPath).isDirectory()) return { ok: false, error: '目录不存在' }
  } catch {
    return { ok: false, error: '目录不存在' }
  }
  return { ok: true }
}

/** 定位视频文件校验（ipc files:locateFile）：同上，但目标必须是存在的文件 */
export function locateVideoFile(downloadDir: string, filePath: string): { ok: boolean; error?: string } {
  if (!isPathInside(downloadDir, filePath)) return { ok: false, error: '非法路径：目标不在下载目录内' }
  try {
    if (!statSync(filePath).isFile()) return { ok: false, error: '文件不存在' }
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  return { ok: true }
}

/** 路径段合法性：空、. / .. 或含路径分隔符的一律拒绝（与 isPathInside 双层防护） */
function isSafeSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

/** 把渲染层传来的相对段落解析成下载目录内的绝对路径；任何一段不合法或最终越界 → null */
function resolveManagedPath(downloadDir: string, segments: string[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null
  if (!segments.every(s => typeof s === 'string' && isSafeSegment(s))) return null
  const target = join(downloadDir, ...segments)
  // 路径穿越防护（path.relative 校验逐条过）：目标必须位于 downloadDir 内，且不能是 downloadDir 自身
  if (!isPathInside(downloadDir, target)) return null
  return target
}

/**
 * 递归删除下载目录内任意层级的目录（ipc files:deleteDir）：段落校验 + 路径防护 → fs.rm(recursive) →
 * DB 联动删该路径前缀 videos 行 → 受影响作者 video_count 重算。
 * 文件夹删除失败（非 ENOENT）→ 返回错误且不动 DB（与 video:delete 语义一致）；ENOENT 视为已删照常清库。
 */
export async function deleteFileDir(deps: FileManagerDeps, segments: string[]): Promise<FileDeleteResult> {
  const { db, downloadDir } = deps
  const target = resolveManagedPath(downloadDir, segments)
  if (!target) return { ok: false, deleted: 0, error: '非法路径：目标不在下载目录内' }
  try {
    if (deps.trash) {
      try { await deps.trash(target) } catch (err) { if (statExists(target)) throw err } // 已经不在了视为删掉
    } else await rm(target, { recursive: true, force: true })
    const { deleted, authorIds } = deleteVideosByPathPrefix(db, target)
    recomputeAuthorCounts(db, authorIds)
    return { ok: true, deleted, filesRemoved: true }
  } catch (err) {
    return { ok: false, deleted: 0, error: String(err) }
  }
}

/**
 * 删除下载目录内的单个视频文件（ipc files:deleteFile）。
 * 库里有对应记录 → 交给 deleteVideoRows（先 cancel 在途、连封面/原片一起删、删行、重算作者计数）；
 * 库里没有记录（手动拷进来的）→ 只删这个文件。只接受会被计入统计的 .mp4；.original.mp4 由成品带着走，不单独删。
 */
export async function deleteFileVideo(deps: FileManagerDeps, segments: string[]): Promise<FileDeleteResult> {
  const { db, downloadDir } = deps
  const target = resolveManagedPath(downloadDir, segments)
  if (!target || !isCountedVideo(segments[segments.length - 1])) return { ok: false, deleted: 0, error: '非法路径：只能删除下载目录内的视频文件' }
  try {
    if (!statSync(target).isFile()) return { ok: false, deleted: 0, error: '文件不存在' }
  } catch {
    return { ok: false, deleted: 0, error: '文件不存在' }
  }
  const ids = (db.prepare('SELECT id FROM videos WHERE local_path = ?').all(target) as unknown as Array<{ id: number }>).map(r => r.id)
  if (ids.length > 0) {
    const r = await deleteVideoRows({ db, downloader: deps.downloader ?? { cancel: () => {} }, downloadDir, trash: deps.trash }, ids)
    return r.ok ? { ok: true, deleted: r.deleted, filesRemoved: true } : { ok: false, deleted: r.deleted, error: r.error }
  }
  try {
    await (deps.trash ?? unlink)(target)
    return { ok: true, deleted: 0, filesRemoved: true }
  } catch (err) {
    return { ok: false, deleted: 0, error: String(err) }
  }
}
