import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

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
    created_at: '2026-08-02T00:00:00.000Z',
    finished_at: null,
    ...overrides
  }
}

const stats: TaskStats = {
  total: 10,
  done: 3,
  failed: 1,
  downloading: 2,
  pending: 0,
  filtered: 0,
  collected: 4,
  cancelled: 0,
  paused: 0
}

describe('TaskList 顶层任务表', () => {
  beforeEach(() => {
    installFakeApi()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
    vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
    vi.mocked(window.api.listTaskVideos).mockResolvedValue([])
  })

  it('只显示 6 个有实际用途的列，不保留永远禁用的任务勾选框', async () => {
    const { container } = render(<TaskList notify={() => {}} />)

    await screen.findByText('平台/类型')
    expect(container.querySelectorAll('thead th')).toHaveLength(6)
    expect(container.querySelector('thead input[disabled]')).toBeNull()

    const taskRow = screen.getByText('douyin/keyword').closest('tr')
    expect(taskRow?.querySelector('input[disabled]')).toBeNull()
  })

  it('展开内容跨越全部 6 列，与表头保持对齐', async () => {
    vi.mocked(window.api.listTasks).mockResolvedValue([makeTask({ status: 'paused', error: 'stalled_verify' })])
    const { container } = render(<TaskList notify={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '展开' }))

    await waitFor(() => {
      const headerCount = container.querySelectorAll('thead th').length
      const spanningCells = container.querySelectorAll('tbody td[colspan]')
      expect(spanningCells).toHaveLength(2)
      for (const cell of spanningCells) expect(Number(cell.getAttribute('colspan'))).toBe(headerCount)
    })
  })

  it('下载统计只渲染数量大于 0 的状态徽标', async () => {
    const { container } = render(<TaskList notify={() => {}} />)
    await screen.findByText('平台/类型')

    expect(container.querySelector('[data-badge="done"]')).toHaveTextContent('完成 3')
    expect(container.querySelector('[data-badge="downloading"]')).toHaveTextContent('下载中 2')
    expect(container.querySelector('[data-badge="failed"]')).toHaveTextContent('失败 1')
    expect(container.querySelector('[data-badge="collected"]')).toHaveTextContent('待下载 4')
    expect(container.querySelector('[data-badge="cancelled"]')).toBeNull()
    expect(container.querySelector('[data-badge="paused"]')).toBeNull()
  })

  it('只有等待或过滤数据时也会显示统计，不留下空白单元格', async () => {
    vi.mocked(window.api.getTaskStats).mockResolvedValue({
      total: 7,
      done: 0,
      failed: 0,
      downloading: 0,
      pending: 5,
      filtered: 2,
      collected: 0,
      cancelled: 0,
      paused: 0
    })
    const { container } = render(<TaskList notify={() => {}} />)
    await screen.findByText('平台/类型')

    expect(container.querySelector('[data-badge="pending"]')).toHaveTextContent('等待 5')
    expect(container.querySelector('[data-badge="filtered"]')).toHaveTextContent('已过滤 2')
  })
})
