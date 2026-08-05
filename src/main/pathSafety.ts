import { relative, isAbsolute, sep } from 'path'

/**
 * 路径穿越防护（Task 3 删除视频 / Task 4 文件管理共用）：
 * p 必须位于 root 目录内才算安全。用 path.relative 校验——相对结果以 '..' 开头（含恰好 '..'）、
 * 跨盘返回绝对路径（win32 上 relative 对异盘返回完整路径）、或 p 就是 root 本身，均判不安全。
 */
export function isPathInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  if (rel === '' || isAbsolute(rel)) return false
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false
  return true
}
