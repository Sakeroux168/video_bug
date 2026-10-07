import type { FilesTree } from '../../../shared/types'

/**
 * 文件管理上次扫到的目录树和所在文件夹（2026-10-07 性能 F3）。切到别的页再回来先显示它，后台再扫一遍新的
 * ——下载目录文件多时扫一遍要一两秒，以前每次进来都是「加载中…」。只活在这次打开程序期间。
 */
export const fileTreeCache: { tree: FilesTree | null; cwd: string[] } = { tree: null, cwd: [] }

export function resetFileTreeCache(): void {
  fileTreeCache.tree = null
  fileTreeCache.cwd = []
}
