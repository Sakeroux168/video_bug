// 安全相关的小工具（2026-10-06 全面检查「安全隐私」A1–A5）。
// 纯函数，不 import electron，主进程和 Node 测试都能用。

/**
 * 本机接口只认本机程序（百家号发布助手用 Python urllib 调，不带 Origin、Host 是 127.0.0.1、JSON）。
 * - 带 Origin：浏览器里的网页跨站请求一定带它 → 拒绝（防恶意网页借用户的登录账号刷抓取任务）；
 * - Host 必须是本机地址 + 本端口：防 DNS 重绑定把恶意域名解析到 127.0.0.1 来读接口；
 * - POST 必须是 JSON：网页不经 CORS 预检发不出 application/json。
 * 合法返回 null，否则返回一句说明。
 */
export function checkBridgeRequest(method: string | undefined, headers: Record<string, string | string[] | undefined>, port: number): string | null {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? ''
  if (one(headers.origin)) return '拒绝网页发来的请求（本机接口只给本机程序用）'
  const host = one(headers.host).toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'Host 不是本机地址，拒绝'
  if (method === 'POST' && !/^application\/json\b/i.test(one(headers['content-type']))) return 'POST 只接受 JSON（Content-Type: application/json）'
  return null
}

/** \\主机\共享、//主机/共享、\\?\UNC\… 这类网络路径。往这种路径建目录会让 Windows 把登录哈希发给对方。
 *  映射成盘符的网络盘（Z:\…）不在此列，按普通本地路径对待。 */
export function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p.trim())
}

/** 本软件自己的页面：打包后是 file://，开发时是本机开发服务器。平台网页（抖音等）一律不算。 */
export function isAppUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return true
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch { return false }
}

/** 网页能申请的权限：只放行全屏和写剪贴板，摄像头、麦克风、定位、通知等一律拒绝 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])
export function allowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

export { neutralizeCsvFormula } from '../shared/csvSafe'
