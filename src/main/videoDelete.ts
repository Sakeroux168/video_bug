import type { DatabaseSync } from 'node:sqlite'
import { unlink } from 'fs/promises'
import { recomputeAuthorCounts } from './db'
import { isPathInside } from './pathSafety'

export interface VideoDeleteDeps {
  db: DatabaseSync
  /** 下载器（需满足 Downloader.cancel 语义：在途 abort 删半成品、排队项移出队列、清 fetching/重试定时器） */
  downloader: { cancel(ids: number[]): void }
  /** 下载目录：local_path 必须位于其内才允许删文件（路径穿越防护） */
  downloadDir: string
}

/**
 * Task3 程序内删除视频编排（ipc video:delete 的核心，抽离主进程便于单测）：
 * 1. 先 downloader.cancel(ids) —— 在途/排队项取消（abort 删半成品、出队、清 fetching），
 *    否则删行后 runOne 继续写盘会留无记录孤儿 mp4；
 * 2. 逐条查视频、封面与可选原片路径，全部安全才逐一 unlink（ENOENT 忽略，其它错误收集并保留 DB 行）；
 * 3. 删 DB 行，收集受影响 author_id；
 * 4. recomputeAuthorCounts 同步作者视频数。
 * 返回 { ok, deleted, error? }：任何异常 → { ok:false, error }。
 */
export async function deleteVideoRows(
  deps: VideoDeleteDeps,
  ids: number[]
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  let deleted = 0 // 放 try 外，异常兜底也能报告已删条数（部分进度）
  try {
    const { db, downloader, downloadDir } = deps
    if (!ids.length) return { ok: true, deleted: 0 }
    downloader.cancel(ids)
    const authorIds: number[] = []
    const errors: string[] = []
    for (const id of ids) {
      const row = db.prepare('SELECT author_id, local_path, cover_path, original_path FROM videos WHERE id = ?')
        .get(id) as { author_id: number | null; local_path: string | null; cover_path: string | null; original_path: string | null } | undefined
      if (!row) continue
      if (row.author_id != null) authorIds.push(row.author_id)
      const paths = [...new Set([row.local_path, row.cover_path, row.original_path].filter((path): path is string => Boolean(path)))]
      // 先统一校验，避免先删安全 MP4 后才发现封面在目录外，造成半套资源。
      if (paths.some(path => !isPathInside(downloadDir, path))) {
        errors.push('删除文件失败：视频资源不在下载目录内')
        continue
      }
      let failed = false
      for (const path of paths) {
        try {
          await unlink(path)
        } catch (err) {
          // ENOENT：文件已被移走/删除，忽略继续删 DB 行；其它错误：报错并保留 DB 行（文件未删，可重试）
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            errors.push(`删除文件失败 ${path}：${String(err)}`)
            failed = true
            break
          }
        }
      }
      if (failed) continue
      db.prepare('DELETE FROM videos WHERE id = ?').run(id)
      deleted++
    }
    recomputeAuthorCounts(db, authorIds)
    if (errors.length) return { ok: false, error: errors.join('；'), deleted }
    return { ok: true, deleted }
  } catch (err) {
    return { ok: false, error: String(err), deleted }
  }
}
