import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 冒烟测试：验证 jsdom + @testing-library 基建可用，TaskList 能渲染标题与任务表格头

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

const emptyStats: TaskStats = {
  total: 10, done: 10, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0
}

describe('TaskList 冒烟', () => {
  beforeEach(() => {
    // 恢复假 api 默认实现，隔离各测试
    installFakeApi()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  })

  it('渲染卡片标题与任务表格头', async () => {
    vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(emptyStats)

    render(<TaskList notify={() => {}} />)

    expect(screen.getByText('任务列表')).toBeInTheDocument()
    // 等异步 listTasks 完成，任务表格头出现
    expect(await screen.findByText('平台/类型')).toBeInTheDocument()
    expect(screen.getByText('关键词')).toBeInTheDocument()
    expect(screen.getByText('进度')).toBeInTheDocument()
    expect(screen.getByText('下载统计')).toBeInTheDocument()
    expect(screen.getByText('操作')).toBeInTheDocument()
  })

  it('无任务时显示空态提示', async () => {
    render(<TaskList notify={() => {}} />)

    expect(screen.getByText('暂无任务，先在上方「筛选条件」发起抓取')).toBeInTheDocument()
  })
})
