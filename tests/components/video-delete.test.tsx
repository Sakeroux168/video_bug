import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// Task 3 程序内删除：行「删除」+ 批量「删除选中」→ window.confirm 确认 → api.deleteVideos → 刷新

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

function makeVideo(id: number, status: VideoRow['status'] = 'done'): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title: `视频${id}`,
    author_id: 1, play_addr: null, source_url: null, cover_url: null, cover_path: null,
    video_width: 0, video_height: 0, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
    stats: '{}', ai_verdict: null, ai_tags: null, status, local_path: null,
    file_size: null, error: null, retry_count: 0, fetched_at: '2026-08-01T00:00:00.000Z',
    downloaded_at: null, author_nickname: '作者'
  }
}

const stats: TaskStats = {
  total: 2, done: 2, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0
}

/** 渲染 1 个任务 + 2 条视频并展开任务，返回视频表格容器 */
async function setup(videos: VideoRow[], notify: (t: string) => void = () => {}): Promise<HTMLElement> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)

  render(<TaskList notify={notify} />)
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('标题') // 视频表格头出现，视频已加载
  return screen.getByTestId('video-table')
}

describe('Task 3 视频删除 UI', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('行「删除」：confirm 确认后调 deleteVideos([id]) 并刷新', async () => {
    const c = await setup([makeVideo(1), makeVideo(2)])
    const row = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    expect(delBtn).toBeTruthy()
    fireEvent.click(delBtn!)
    expect(window.confirm).toHaveBeenCalledWith('确定删除该视频？将同时删除本地文件')
    expect(window.api.deleteVideos).toHaveBeenCalledWith([1])
  })

  it('行「删除」：confirm 取消则不调用 deleteVideos', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const c = await setup([makeVideo(1)])
    const row = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    expect(window.api.deleteVideos).not.toHaveBeenCalled()
  })

  it('批量「删除选中(N)」：勾选后 confirm 确认 → deleteVideos 传选中 id 列表', async () => {
    const c = await setup([makeVideo(1), makeVideo(2)])
    // 勾选第 1 行（复选框）
    const row1 = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const cb = row1.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(cb)
    const batchBtn = screen.getByText('删除选中(1)')
    fireEvent.click(batchBtn)
    // N=1 走单条确认文案，N>1 才走批量文案
    expect(window.confirm).toHaveBeenCalledWith('确定删除该视频？将同时删除本地文件')
    expect(window.api.deleteVideos).toHaveBeenCalledWith([1])
  })

  it('未勾选时批量删除按钮禁用', async () => {
    await setup([makeVideo(1), makeVideo(2)])
    const btn = screen.getByText('删除选中(0)') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('删除成功 → notify 已删除并刷新列表', async () => {
    const notify = vi.fn()
    await setup([makeVideo(1), makeVideo(2)], notify)
    // setup 内 installFakeApi 会重置方法，须在 setup 之后再 mock 返回值
    vi.mocked(window.api.deleteVideos).mockResolvedValue({ ok: true, deleted: 1 })
    const c = screen.getByTestId('video-table')
    const row = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    // deleteVideos 是异步的，notify 在 .then 微任务里调用，需等待
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 1 个视频'))
    expect(window.api.listTasks).toHaveBeenCalled()
  })

  it('部分失败（ok:false 但 deleted>0）→ 仍刷新并提示已删条数', async () => {
    const notify = vi.fn()
    await setup([makeVideo(1), makeVideo(2)], notify)
    vi.mocked(window.api.deleteVideos).mockResolvedValue({ ok: false, deleted: 1, error: '删除文件失败 C:\\x.mp4' })
    const callsBefore = vi.mocked(window.api.listTasks).mock.calls.length
    const c = screen.getByTestId('video-table')
    const row = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 1 条，部分失败：删除文件失败 C:\\x.mp4'))
    // 已删部分照常刷新（listTasks 被再次调用）
    await waitFor(() => expect(vi.mocked(window.api.listTasks).mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('全部失败（deleted=0）→ 只提示错误，不刷新', async () => {
    const notify = vi.fn()
    await setup([makeVideo(1)], notify)
    vi.mocked(window.api.deleteVideos).mockResolvedValue({ ok: false, deleted: 0, error: '磁盘错误' })
    const callsBefore = vi.mocked(window.api.listTasks).mock.calls.length
    const c = screen.getByTestId('video-table')
    const row = c.querySelector('tbody tr[data-id="1"]') as HTMLElement
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('删除失败：磁盘错误'))
    expect(vi.mocked(window.api.listTasks).mock.calls.length).toBe(callsBefore) // 无删除 → 不刷新
  })
})
