import type { DatabaseSync } from 'node:sqlite'

/** R11-3：重启恢复——把 DB 里遗留 status='pending' 的任务重新入队。
 *  任务队列是主进程内存 FIFO（pendingTasks），重启即空；不恢复则旧任务永远卡「等待」没人启动。
 *  顺序按 id（先建先跑）；enqueue 自带去重（queuedTaskIds），重复调用安全。 */
export function enqueuePendingTasks(db: DatabaseSync, enqueue: (id: number) => void): void {
  const rows = db.prepare("SELECT id FROM tasks WHERE status='pending' ORDER BY id").all() as Array<{ id: number }>
  for (const r of rows) enqueue(r.id)
}
