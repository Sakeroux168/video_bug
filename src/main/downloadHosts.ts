import { isIP } from 'node:net'
import { getAdapter } from './adapters'

/**
 * 下载地址白名单（2026-10-07 安全加固 A8，全面检查 安全 M5）。
 * 视频 / 封面地址来自平台页面的接口数据；以前是什么地址就请求什么，页面里的第三方嵌入框伪造一条数据，
 * 就能让主进程去请求内网、127.0.0.1 或任意网站。现在只认 http(s) + 各平台适配器声明的域名（含子域名），
 * IP 地址和 localhost 一律不认。
 */
export function isAllowedMediaUrl(platform: string, url: string | null | undefined): boolean {
  if (!url) return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || isIP(host) !== 0) return false
  const allowed = getAdapter(platform)?.downloadHosts ?? []
  return allowed.some(d => host === d || host.endsWith(`.${d}`))
}
