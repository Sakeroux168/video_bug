import { it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 老陈复测 🟠：追更没抓到新视频时只显示 0/3 + 完成，分不清是博主没更新还是软件没抓到
const stats: TaskStats = { total: 0, done: 0, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 }
function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 1, platform: 'xiaohongshu', type: 'author', query: 'U1',
    filters: JSON.stringify({ timeRange: 'custom', startDate: '2026-10-01', duration: 'all', targetCount: 3 }),
    status: 'done', target_count: 3, fetched_count: 0, auto_download: 1,
    error: null, created_at: '2026-10-06T00:00:00.000Z', finished_at: '2026-10-06T00:01:00.000Z', ...over
  }
}
beforeEach(() => {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
})

it('作者追更（日期段）完成但 0 条 → 写明「这段时间没有新作品」和起始日期', async () => {
  vi.mocked(window.api.listTasks).mockResolvedValue([task({})])
  render(<TaskList notify={() => {}} />)
  expect(await screen.findByText(/2026-10-01 以后没有新作品/)).toBeInTheDocument()
})

it('抓到了视频，或者不是日期段任务 → 不显示这句', async () => {
  vi.mocked(window.api.listTasks).mockResolvedValue([
    task({ id: 1, fetched_count: 2 }),
    task({ id: 2, filters: JSON.stringify({ timeRange: 'all', duration: 'all', targetCount: 3 }) })
  ])
  render(<TaskList notify={() => {}} />)
  await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(2))
  expect(screen.queryByText(/没有新作品/)).toBeNull()
})
