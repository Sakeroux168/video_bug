import type { DatabaseSync } from 'node:sqlite'
import type { Dirent } from 'fs'
import { readdirSync, statSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, join } from 'path'
import { deleteVideosByPathPrefix, recomputeAuthorCounts } from './db'
import { isPathInside } from './pathSafety'
import type { FileDeleteResult, FilesTree, FilesTreeAuthor, FilesTreeCategory } from '../shared/types'

export interface FileManagerDeps {
  db: DatabaseSync
  /** 下载目录：删除目标必须位于其内（路径穿越防护） */
  downloadDir: string
}

/** 隐藏/临时目录或文件（~ 或 . 开头）一律跳过，不进树也不参与统计 */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~')
}

/** 递归统计目录内 .mp4 视频（organizer 归档为 {品类}/{作者}/{时长分桶}/xxx.mp4，须递归），跳过隐藏/临时项 */
function countMp4s(dir: string): { count: number; size: number } {
  let count = 0
  let size = 0
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return { count, size } }
  for (const e of entries) {
    if (isIgnoredName(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = countMp4s(p)
      count += sub.count
      size += sub.size
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.mp4')) {
      // 文件在统计瞬间被删（竞态）→ 忽略该文件，不中断整次扫描
      try { size += statSync(p).size } catch { /* 忽略 */ }
      count++
    }
  }
  return { count, size }
}

/** 扫描一个品类目录：子目录 = 作者（视频递归统计），直接落在品类下的 mp4 计入品类总量 */
function scanCategory(dir: string): FilesTreeCategory | null {
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  const authors: FilesTreeAuthor[] = []
  let videoCount = 0
  let size = 0
  for (const e of entries) {
    if (isIgnoredName(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const { count, size: s } = countMp4s(p)
      authors.push({ name: e.name, videoCount: count, size: s })
      videoCount += count
      size += s
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.mp4')) {
      try { size += statSync(p).size } catch { /* 忽略 */ }
      videoCount++
    }
  }
  return { name: basename(dir), videoCount, size, authors }
}

/**
 * Task4 文件管理：扫描下载目录 → { 品类 → 作者 → 视频 } 树。
 * 一级目录 = 品类、二级目录 = 作者、.mp4 文件 = 视频；隐藏/临时项（~ . 开头）跳过；
 * 目录不存在或为空 → { categories: [] }；totalSize = 所有品类合计，downloadDir 回传供前端拼定位路径。
 * 纯函数（不入库、不落盘），便于单测。
 */
export function scanFilesTree(downloadDir: string): FilesTree {
  const categories: FilesTreeCategory[] = []
  let totalSize = 0
  let entries: Dirent[]
  try { entries = readdirSync(downloadDir, { withFileTypes: true }) } catch { return { categories, totalSize, downloadDir } }
  for (const e of entries) {
    if (isIgnoredName(e.name) || !e.isDirectory()) continue // 顶层只认目录当品类
    const cat = scanCategory(join(downloadDir, e.name))
    if (cat) { categories.push(cat); totalSize += cat.size }
  }
  return { categories, totalSize, downloadDir }
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

/** 删除目标名合法性：空、. / .. 或含路径分隔符的一律拒绝（与 isPathInside 双层防护） */
function assertSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

/**
 * 递归删除品类目录（ipc files:deleteCategory）：路径防护 → fs.rm(recursive) →
 * DB 联动删该路径前缀 videos 行 → 受影响作者 video_count 重算。
 * 文件夹删除失败（非 ENOENT）→ 返回错误且不动 DB（与 video:delete 语义一致）；ENOENT 视为已删照常清库。
 */
export async function deleteFileCategory(deps: FileManagerDeps, name: string): Promise<FileDeleteResult> {
  if (!assertSafeName(name)) return { ok: false, deleted: 0, error: '非法路径' }
  return deleteFolder(deps, join(deps.downloadDir, name))
}

/** 递归删除作者目录（ipc files:deleteAuthor），语义同上 */
export async function deleteFileAuthor(deps: FileManagerDeps, category: string, author: string): Promise<FileDeleteResult> {
  if (!assertSafeName(category) || !assertSafeName(author)) return { ok: false, deleted: 0, error: '非法路径' }
  return deleteFolder(deps, join(deps.downloadDir, category, author))
}

async function deleteFolder(deps: FileManagerDeps, target: string): Promise<FileDeleteResult> {
  const { db, downloadDir } = deps
  try {
    // 路径穿越防护（path.relative 校验逐条过）：目标必须位于 downloadDir 内，且不能是 downloadDir 自身
    if (!isPathInside(downloadDir, target)) return { ok: false, deleted: 0, error: '非法路径：目标不在下载目录内' }
    await rm(target, { recursive: true, force: true })
    const { deleted, authorIds } = deleteVideosByPathPrefix(db, target)
    recomputeAuthorCounts(db, authorIds)
    return { ok: true, deleted, filesRemoved: true }
  } catch (err) {
    return { ok: false, deleted: 0, error: String(err) }
  }
}
