import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 存量问题（不是概览页引入的）：TaskList 此前对每个事件都无条件全量重拉。
// 下载器每个视频至少 emit 3 次状态，500 个视频 ≈ 1500 次事件 × 7 次 IPC，
// 且每次把整个视频数组序列化过 contextBridge。这条测试把「合并」钉住。
//
// 注：现有 14 处 onTaskProgress 全部 mock 成返回 noop 退订函数，
// **从来没有测试真的触发过回调** —— 所以这条路径此前零覆盖。

const task = (id: number): TaskRow => ({
  id, platform: 'douyin', type: 'keyword', query: `词${id}`, filters: '{}',
  status: 'running', target_count: 200, fetched_count: 10, auto_download: 1,
  error: null, created_at: '2026-08-01T00:00:00.000Z', finished_at: null
})
const stats: TaskStats = {
  total: 0, done: 0, failed: 0, downloading: 0, pending: 0,
  filtered: 0, collected: 0, cancelled: 0, paused: 0
}

describe('TaskList 事件风暴', () => {
  beforeEach(() => { installFakeApi() })

  it('同步收到 30 个事件 → listTasks 调用次数被合并（不是 30+ 次）', async () => {
    let fire: ((e: unknown) => void) | null = null
    vi.mocked(window.api.onTaskProgress).mockImplementation((cb: (e: never) => void) => {
      fire = cb as (e: unknown) => void
      return () => {}
    })
    vi.mocked(window.api.listTasks).mockResolvedValue([task(1), task(2)])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)

    render(<TaskList notify={() => {}} />)
    await screen.findByText(/词1/)
    const before = vi.mocked(window.api.listTasks).mock.calls.length

    // 模拟下载器的连续状态推送
    for (let i = 0; i < 30; i++) {
      fire!({ type: 'video:status', id: i, status: 'done' })
    }
    await waitFor(() => expect(vi.mocked(window.api.listTasks).mock.calls.length).toBeGreaterThanOrEqual(before))

    const added = vi.mocked(window.api.listTasks).mock.calls.length - before
    // 合并前：30 次事件 → 30 次重拉。合并后应该是个位数。
    expect(added, `30 个事件只应触发少量重拉，实际 ${added} 次`).toBeLessThanOrEqual(2)
  })

  it('reSearchCount 徽标仍然逐条更新（节流不能吞掉这个即时反馈）', async () => {
    let fire: ((e: unknown) => void) | null = null
    vi.mocked(window.api.onTaskProgress).mockImplementation((cb: (e: never) => void) => {
      fire = cb as (e: unknown) => void
      return () => {}
    })
    vi.mocked(window.api.listTasks).mockResolvedValue([task(1)])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)

    render(<TaskList notify={() => {}} />)
    await screen.findByText(/词1/)
    fire!({ type: 'task:progress', taskId: 1, fetched: 5, status: 'running', reSearchCount: 2 })
    await screen.findByText(/重搜 2/)
  })
})
