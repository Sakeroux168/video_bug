import type { DatabaseSync } from 'node:sqlite'

/** R11-3：重启恢复——把 DB 里遗留 status='pending' 的任务重新入队。
 *  任务队列是主进程内存 FIFO（taskQueue.ts），重启即空；不恢复则旧任务永远卡「等待」没人启动。
 *  顺序按 id（先建先跑）；enqueue 自带去重，重复调用安全。 */
export function enqueuePendingTasks(db: DatabaseSync, enqueue: (id: number) => void): void {
  const rows = db.prepare("SELECT id FROM tasks WHERE status='pending' ORDER BY id").all() as Array<{ id: number }>
  for (const r of rows) enqueue(r.id)
}

/**
 * 重启恢复下载：在途任务回到等待并重新入队。
 * local_path 可能是已校验的隐藏源文件断点，必须原样保留给 Downloader 复验复用。
 */
export function recoverPendingVideos(db: DatabaseSync, enqueue: (id: number) => void): void {
  db.prepare("UPDATE videos SET status='pending' WHERE status='downloading'").run()
  const rows = db.prepare("SELECT id FROM videos WHERE status='pending' ORDER BY id").all() as Array<{ id: number }>
  for (const row of rows) enqueue(row.id)
}
