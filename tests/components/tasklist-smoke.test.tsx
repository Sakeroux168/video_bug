import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('创建任务后的刷新版本变化会立即重拉任务列表', async () => {
    const { rerender } = render(<TaskList notify={() => {}} refreshVersion={0} />)
    await waitFor(() => expect(window.api.listTasks).toHaveBeenCalledTimes(1))
    rerender(<TaskList notify={() => {}} refreshVersion={1} />)
    await waitFor(() => expect(window.api.listTasks).toHaveBeenCalledTimes(2))
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
  // 用户实测：爬作者时任务列表的「关键词」是一串英文（sec_uid），认不出是谁。
  it('作者任务显示作者名而不是 sec_uid；库里没该作者时回落显示原值', async () => {
    installFakeApi()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
    vi.mocked(window.api.getTaskStats).mockResolvedValue(emptyStats)
    vi.mocked(window.api.listTaskVideos).mockResolvedValue([])
    vi.mocked(window.api.listTasks).mockResolvedValue([
      { ...makeTask(1), type: 'author', query: 'MS4wLjABAAAAxyz', author_nickname: '张三' },
      { ...makeTask(2), type: 'author', query: 'MS4wLjABAAAAnobody', author_nickname: null }
    ] as never)

    const { container } = render(<TaskList notify={() => {}} />)
    await screen.findByText(/张三/)
    const text = container.textContent ?? ''
    expect(text).not.toContain('MS4wLjABAAAAxyz')   // 有昵称就不再显示 sec_uid
    expect(text).toContain('MS4wLjABAAAAnobody')    // 没昵称则回落原值，不能显示空白
  })

})
