import { api } from '../api'
import type { Notify } from './Notice'

/** 三个入口共用同一保存和反馈链路；BOM 与文件名重名处理交给主进程。 */
export async function saveCsvFile(csv: string, fileName: string, count: number, notify: Notify): Promise<void> {
  try {
    const result = await api.exportCsv({ csv, fileName })
    if (!result.ok) { notify(result.error); return }
    notify(`已导出 ${count} 条 → ${result.fileName}`, {
      duration: 15000,
      action: {
        label: '打开所在文件夹',
        onClick: async () => {
          try {
            const located = await api.revealExport(result.path)
            if (!located.ok) notify(located.error ?? '无法打开下载文件夹，请稍后重试')
          } catch { notify('无法打开下载文件夹，请稍后重试') }
        }
      }
    })
  } catch { notify('导出失败，请稍后重试；如果仍失败，请重新打开程序') }
}
