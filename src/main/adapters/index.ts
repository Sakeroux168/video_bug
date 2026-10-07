import type { PlatformAdapter } from './types'
import { douyinAdapter } from './douyin'
import { kuaishouAdapter } from './kuaishou'
import { xiaohongshuAdapter } from './xiaohongshu'

const registry: Record<string, PlatformAdapter> = {
  douyin: douyinAdapter,
  kuaishou: kuaishouAdapter,
  // 小红书关键词/话题走搜索响应，作者主页从带播放标识的 DOM 卡片收集详情入口。
  xiaohongshu: xiaohongshuAdapter
}

export function getAdapter(name: string): PlatformAdapter | undefined {
  return registry[name]
}

/** 供渲染层用的平台元数据。界面文案一律从这里取，不在组件里写 `platform === 'douyin'`。 */
export interface PlatformInfo {
  name: string
  displayName: string
  authorInputPlaceholder: string
  /** false 的平台只在「内置浏览器」页出现（登录/抓包用），不进建任务与导入作者的下拉框 */
  taskReady: boolean
  supportedTaskTypes?: PlatformAdapter['supportedTaskTypes']
  interactions?: PlatformAdapter['interactions']
  sortOptions?: PlatformAdapter['sortOptions']
}

export function listAdapters(): PlatformInfo[] {
  return Object.values(registry).map(a => ({
    name: a.name,
    displayName: a.displayName,
    authorInputPlaceholder: a.authorInputPlaceholder,
    taskReady: a.taskReady,
    supportedTaskTypes: a.supportedTaskTypes,
    interactions: a.interactions,
    sortOptions: a.sortOptions
  }))
}
