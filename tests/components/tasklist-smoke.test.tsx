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

// R20：看门狗判卡住的任务要说清楚，不能只显示「已暂停」让人以为是自己点的
describe('卡住的任务（R20）', () => {
  it('error=stuck 的暂停任务显示「卡住了，已跳过」并提示可点「继续」重试', async () => {
    installFakeApi()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
    vi.mocked(window.api.getTaskStats).mockResolvedValue(emptyStats)
    vi.mocked(window.api.listTasks).mockResolvedValue([
      { ...makeTask(1), status: 'paused', error: 'stuck' },
      { ...makeTask(2), status: 'paused', error: 'user' }
    ] as never)

    render(<TaskList notify={() => {}} />)
    expect(await screen.findByText('卡住了，已跳过')).toBeInTheDocument()
    expect(screen.getByText(/卡住了，已跳过（可点「继续」重试）/)).toBeInTheDocument()
    expect(screen.getAllByText('已暂停')).toHaveLength(1) // 用户自己暂停的照旧
    expect(screen.getAllByRole('button', { name: '继续' })).toHaveLength(2)
  })
})

// R20 复查：用户暂停 / 疑似风控 / 要过验证后队列按住不自动跑——界面要说清楚、给出接着跑的办法
describe('队列按住时的提示（R20 复查）', () => {
  function prep(tasks: unknown[]): void {
    installFakeApi()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
    vi.mocked(window.api.getTaskStats).mockResolvedValue(emptyStats)
    vi.mocked(window.api.listTasks).mockResolvedValue(tasks as never)
  }

  it('有暂停的任务（用户暂停）+ 有排队的 + 没有在跑的 → 提示点「开始」/「继续」接着跑，排队任务有「开始」按钮', async () => {
    prep([{ ...makeTask(1), status: 'paused', error: 'user' }, { ...makeTask(2), status: 'pending' }])
    const { container } = render(<TaskList notify={() => {}} />)
    await screen.findByText(/排队的任务先不自动开跑/)
    expect(container.querySelector('[data-queue-held]')!.textContent).toContain('开始')
    expect(screen.getByRole('button', { name: '开始' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
  })

  it('疑似风控暂停 → 行下说明「疑似风控，已暂停」', async () => {
    prep([{ ...makeTask(1), status: 'paused', error: 'risk' }, { ...makeTask(2), status: 'pending' }])
    render(<TaskList notify={() => {}} />)
    expect(await screen.findByText(/疑似风控，已暂停/)).toBeInTheDocument()
    expect(screen.getByText(/排队的任务先不自动开跑/)).toBeInTheDocument()
  })

  it('有任务在跑 / 没有排队的 → 不显示提示', async () => {
    prep([{ ...makeTask(1), status: 'paused', error: 'user' }, { ...makeTask(2), status: 'running' }, { ...makeTask(3), status: 'pending' }])
    render(<TaskList notify={() => {}} />)
    await screen.findAllByText(/测试/)
    expect(screen.queryByText(/排队的任务先不自动开跑/)).toBeNull()
  })
})
