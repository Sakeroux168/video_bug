import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 批量暂停/继续（需求 2026-08-02h ②）：工具栏计数按各自状态集过滤（完整 selected，跨页）、
// 空则禁用、点击调 pauseVideos/resumeVideos。暂停集 = pending/downloading，继续集 = paused，互斥。

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 100, fetched_count: 100, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

function makeVideo(id: number, overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title: `视频${id}`,
    author_id: null, play_addr: null, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
    stats: '{}', ai_verdict: null, ai_tags: null, status: 'collected', local_path: null,
    file_size: null, error: null, retry_count: 0, fetched_at: '2026-08-01T00:00:00.000Z',
    downloaded_at: null, author_nickname: '作者', ...overrides
  }
}

function makeStats(videos: VideoRow[]): TaskStats {
  const s: TaskStats = { total: videos.length, done: 0, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 }
  for (const v of videos) {
    if (v.status === 'done') s.done++
    else if (v.status === 'failed') s.failed++
    else if (v.status === 'downloading') s.downloading++
    else if (v.status === 'pending') s.pending++
    else if (v.status === 'paused') s.paused++
    else if (v.status === 'collected') s.collected++
  }
  return s
}

/** 渲染 TaskList（1 个任务）并展开任务，返回视频表格容器 div */
async function setup(videos: VideoRow[]): Promise<HTMLElement> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(makeStats(videos))
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)

  render(<TaskList notify={() => {}} />)
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('标题') // 视频表格头出现
  return screen.getByText('标题').closest('table')!.parentElement as HTMLElement
}

/** ctrl+点击行 = 切换选中（不清其它），与 selection.test.tsx 手势一致 */
function toggleRow(containerDiv: HTMLElement, id: number): void {
  const tr = containerDiv.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement
  fireEvent.mouseDown(tr, { ctrlKey: true })
  fireEvent.mouseUp(tr, { ctrlKey: true })
  fireEvent.click(tr, { ctrlKey: true })
}

describe('批量暂停/继续（视频表格工具栏）', () => {
  beforeEach(() => {
    installFakeApi()
  })

  it('混合状态勾选：暂停/继续计数按各自状态集过滤，点击调用对应批量接口', async () => {
    const c = await setup([
      makeVideo(1, { status: 'pending' }),
      makeVideo(2, { status: 'downloading' }),
      makeVideo(3, { status: 'paused' }),
      makeVideo(4, { status: 'collected' }),
      makeVideo(5, { status: 'done' })
    ])
    // 勾选 pending + downloading + paused + done（done 不属于任何批量集，应被排除）
    toggleRow(c, 1)
    toggleRow(c, 2)
    toggleRow(c, 3)
    toggleRow(c, 5)

    // 计数 = selected ∩ 各自状态集：暂停 2（1/2），继续 1（3）；done 不计入
    const pauseBtn = screen.getByText('暂停选中(2)') as HTMLButtonElement
    const resumeBtn = screen.getByText('继续选中(1)') as HTMLButtonElement
    expect(pauseBtn).toBeEnabled()
    expect(resumeBtn).toBeEnabled()
    expect(screen.queryByText('暂停选中(3)')).not.toBeInTheDocument()
    expect(screen.queryByText('继续选中(2)')).not.toBeInTheDocument()

    // 点「暂停选中」→ pauseVideos([1, 2]) 并通知；「继续选中」→ resumeVideos([3])
    fireEvent.click(pauseBtn)
    expect(window.api.pauseVideos).toHaveBeenCalledWith([1, 2])
    fireEvent.click(screen.getByText('继续选中(1)'))
    expect(window.api.resumeVideos).toHaveBeenCalledWith([3])
  })

  it('无匹配状态时两按钮禁用（0），disabled 点击不调接口', async () => {
    await setup([
      makeVideo(4, { status: 'collected' }),
      makeVideo(5, { status: 'done' })
    ])
    // 勾选 collected + done：均不属于暂停/继续集
    toggleRow(screen.getByText('标题').closest('table')!.parentElement as HTMLElement, 4)

    const pauseBtn = screen.getByText('暂停选中(0)') as HTMLButtonElement
    const resumeBtn = screen.getByText('继续选中(0)') as HTMLButtonElement
    expect(pauseBtn).toBeDisabled()
    expect(resumeBtn).toBeDisabled()

    fireEvent.click(pauseBtn)
    fireEvent.click(resumeBtn)
    expect(window.api.pauseVideos).not.toHaveBeenCalled()
    expect(window.api.resumeVideos).not.toHaveBeenCalled()
  })

  it('跨页：完整 selected 按状态过滤，翻页后计数保持', async () => {
    // 55 条（> 每页 50）→ 第 2 页有 5 条；两页各选一个 pending
    const videos = Array.from({ length: 55 }, (_, i) => makeVideo(i + 1, { status: 'collected' }))
    videos[0] = makeVideo(1, { status: 'pending' })
    videos[50] = makeVideo(51, { status: 'pending' })
    const c = await setup(videos)

    toggleRow(c, 1)
    fireEvent.click(screen.getByText('下一页'))
    toggleRow(c, 51)

    // 第 2 页可见（第 1 页行不在视图），计数仍为跨页完整 selected ∩ pending = 2
    const pauseBtn = screen.getByText('暂停选中(2)') as HTMLButtonElement
    expect(pauseBtn).toBeEnabled()
    fireEvent.click(pauseBtn)
    expect(window.api.pauseVideos).toHaveBeenCalledWith([1, 51])
  })
})
