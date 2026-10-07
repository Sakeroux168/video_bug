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

/**
 * 写日志用的地址：只留站点和路径，? 后面的参数一律不要（2026-10-07 安全加固 L3）。
 * 参数里有设备号、msToken、xsec_token 这类东西，以前只靠「截前 120 个字」挡着。
 */
export function logUrl(url: string): string {
  return String(url ?? '').replace(/[?#].*$/s, '')
}

/** 平台窗口的主页面只在本平台的网站里跳（含登录、验证用的子域名）；别的网站交给系统浏览器（L1） */
export function isPlatformNavigation(adapter: { navHosts: readonly string[] }, url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  return adapter.navHosts.some(d => host === d || host.endsWith(`.${d}`))
}

/** 页面要打开的外部网页交给系统浏览器：只认 http(s)，间隔太近的不开（页面不能一直往外弹，L1） */
export class ExternalOpener {
  private last = -Infinity
  constructor(private deps: { open: (url: string) => void; now?: () => number; gapMs?: number }) {}
  open(url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    const now = (this.deps.now ?? Date.now)()
    if (now - this.last < (this.deps.gapMs ?? 5000)) return
    this.last = now
    this.deps.open(url)
  }
}
