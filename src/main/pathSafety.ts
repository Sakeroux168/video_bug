import { relative, isAbsolute, sep, dirname, basename, join } from 'path'
import { realpathSync } from 'fs'

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

/**
 * 按真实路径判断（2026-10-07 安全加固 L6）：先按字面判断，再把目录联接 / 符号链接解开再判一次。
 * 下载目录里如果有指向外面的联接，字面上在里面、实际删的是外面的文件——删除前要用这个。
 * 路径还不存在时，找到最近一层存在的上级解开，再把剩下的部分接回去。
 */
export function isRealPathInside(root: string, p: string): boolean {
  if (!isPathInside(root, p)) return false
  let realRoot = root
  try { realRoot = realpathSync.native(root) } catch { /* 下载目录不存在：按字面 */ }
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return isPathInside(realRoot, join(realpathSync.native(cur), ...rest))
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return false
      rest.unshift(basename(cur))
      cur = parent
    }
  }
}
