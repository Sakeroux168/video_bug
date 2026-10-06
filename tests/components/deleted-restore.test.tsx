import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// B5：删掉的视频以后又想要了 → 任务里点「已删除(N)」看到它们，点「恢复下载」重新下载

function makeTask(): TaskRow {
  return {
    id: 1, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 1,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}
function makeVideo(id: number, title: string, status: VideoRow['status']): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title,
    author_id: 1, play_addr: null, source_url: null, cover_url: null, cover_path: null,
    original_path: null, normalization_error: null,
    video_width: 0, video_height: 0, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
    stats: '{}', ai_verdict: null, ai_tags: null, status, local_path: null,
    file_size: null, error: null, retry_count: 0, fetched_at: '2026-08-01T00:00:00.000Z',
    downloaded_at: null, author_nickname: '作者'
  }
}

async function setup(deleted: number) {
  installFakeApi()
  const notify = vi.fn()
  const stats: TaskStats = { total: 1, done: 1, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0, deleted }
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue([makeVideo(1, '还在的视频', 'done')])
  vi.mocked(window.api.listDeletedTaskVideos).mockResolvedValue([makeVideo(2, '删掉的视频', 'deleted'), makeVideo(3, '也删了', 'deleted')])
  render(<TaskList notify={notify} />)
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('还在的视频')
  return { notify }
}

describe('已删除的视频可以恢复下载', () => {
  it('没有删过的 → 不显示「已删除」按钮', async () => {
    await setup(0)
    expect(screen.queryByRole('button', { name: /已删除/ })).toBeNull()
  })

  it('点「已删除(2)」→ 列出删掉的视频；点某条的「恢复下载」→ 只恢复那一条', async () => {
    const { notify } = await setup(2)
    fireEvent.click(screen.getByRole('button', { name: '已删除(2)' }))
    expect(await screen.findByText('删掉的视频')).toBeInTheDocument()
    expect(screen.getByText('也删了')).toBeInTheDocument()
    vi.mocked(window.api.restoreVideos).mockResolvedValue({ restored: 1 })
    const row = screen.getByText('删掉的视频').closest('li')!
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(window.api.restoreVideos).toHaveBeenCalledWith([2]))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已恢复 1 个视频，开始重新下载'))
  })

  it('「全部恢复下载」→ 恢复这个任务删掉的全部视频', async () => {
    await setup(2)
    fireEvent.click(screen.getByRole('button', { name: '已删除(2)' }))
    await screen.findByText('删掉的视频')
    vi.mocked(window.api.restoreVideos).mockResolvedValue({ restored: 2 })
    fireEvent.click(screen.getByRole('button', { name: '全部恢复下载(2)' }))
    await waitFor(() => expect(window.api.restoreVideos).toHaveBeenCalledWith([2, 3]))
  })
})
