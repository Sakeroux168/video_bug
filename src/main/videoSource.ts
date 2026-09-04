import { getAdapter } from './adapters'

export function resolveVideoSourceUrl(
  platform: string,
  workId: string,
  storedUrl: string | null
): string | null {
  const adapter = getAdapter(platform)
  if (!adapter) return null
  const candidate = storedUrl === null || storedUrl.trim() === ''
    ? adapter.buildVideoUrl(workId)
    : storedUrl
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || !adapter.sourceHosts.includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}
