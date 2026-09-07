import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// D 阶段：任务列表以前直接显示 `kuaishou/keyword` 这种原始值，员工看不懂。
// 平台显示名集中在适配器里（platforms:list 带出），界面不写 platform === 'douyin' 这类分支。

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'https://www.douyin.com/user/xxx' },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'https://www.kuaishou.com/profile/xxx' }
]

const stats: TaskStats = {
  total: 1, done: 1, failed: 0, downloading: 0,
  pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1,
    platform: 'douyin',
    type: 'keyword',
    query: '测试',
    filters: '{}',
    status: 'done',
    target_count: 10,
    fetched_count: 10,
    auto_download: 0,
    error: null,
    created_at: '2026-09-07T00:00:00.000Z',
    finished_at: null,
    ...overrides
  }
}

async function renderWith(task: TaskRow): Promise<void> {
  vi.mocked(window.api.listTasks).mockResolvedValue([task])
  render(<TaskList notify={() => {}} />)
  await screen.findByText('平台/类型')
}

beforeEach(() => {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue([])
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
})

describe('任务列表的平台与类型显示中文', () => {
  it('抖音关键词任务显示「抖音 · 关键词」，不再显示 douyin/keyword', async () => {
    await renderWith(makeTask())
    expect(await screen.findByText('抖音 · 关键词')).toBeInTheDocument()
    expect(screen.queryByText('douyin/keyword')).not.toBeInTheDocument()
  })

  it('快手作者任务显示「快手 · 作者」', async () => {
    await renderWith(makeTask({ platform: 'kuaishou', type: 'author' }))
    expect(await screen.findByText('快手 · 作者')).toBeInTheDocument()
  })

  it('话题类型显示「话题」', async () => {
    await renderWith(makeTask({ platform: 'kuaishou', type: 'hashtag' }))
    expect(await screen.findByText('快手 · 话题')).toBeInTheDocument()
  })

  it('未知平台回落显示原始值，不留空白（库里可能有历史行或未来平台）', async () => {
    await renderWith(makeTask({ platform: 'weibo' }))
    expect(await screen.findByText('weibo · 关键词')).toBeInTheDocument()
  })

  it('平台列表还没到达时也不空白，先显示原始平台名', async () => {
    vi.mocked(window.api.listPlatforms).mockReturnValue(new Promise(() => {}) as never)
    await renderWith(makeTask({ platform: 'kuaishou' }))
    expect(await screen.findByText('kuaishou · 关键词')).toBeInTheDocument()
  })
})
