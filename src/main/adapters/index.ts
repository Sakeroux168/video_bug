import type { PlatformAdapter } from './types'
import { douyinAdapter } from './douyin'
import { kuaishouAdapter } from './kuaishou'

const registry: Record<string, PlatformAdapter> = {
  douyin: douyinAdapter,
  kuaishou: kuaishouAdapter
}

export function getAdapter(name: string): PlatformAdapter | undefined {
  return registry[name]
}

/** 供渲染层用的平台元数据。界面文案一律从这里取，不在组件里写 `platform === 'douyin'`。 */
export interface PlatformInfo {
  name: string
  displayName: string
  authorInputPlaceholder: string
}

export function listAdapters(): PlatformInfo[] {
  return Object.values(registry).map(a => ({
    name: a.name,
    displayName: a.displayName,
    authorInputPlaceholder: a.authorInputPlaceholder
  }))
}
