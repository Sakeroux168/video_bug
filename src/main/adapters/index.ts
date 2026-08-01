import type { PlatformAdapter } from './types'
import { douyinAdapter } from './douyin'

const registry: Record<string, PlatformAdapter> = { douyin: douyinAdapter }

export function getAdapter(name: string): PlatformAdapter | undefined {
  return registry[name]
}

export function listAdapters(): Array<{ name: string; displayName: string }> {
  return Object.values(registry).map(a => ({ name: a.name, displayName: a.displayName }))
}
