import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, TaskStats, VideoRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

const task: TaskRow = {
  id: 1, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
  status: 'done', target_count: 10, fetched_count: 4, auto_download: 0,
  error: null, created_at: '2026-09-04T00:00:00.000Z', finished_at: null
}

const taskStats: TaskStats = {
  total: 4, done: 0, failed: 0, downloading: 0, pending: 0,
  filtered: 0, collected: 4, cancelled: 0, paused: 0
}

function video(id: number, title: string, stats: string, sourceUrl: string | null = `https://www.douyin.com/video/AW${id}`): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `AW${id}`, title,
    author_id: 1, play_addr: 'https://cdn.test/video.mp4', source_url: sourceUrl,
    cover_url: null, cover_path: null, video_width: 1080, video_height: 1920,
    duration: 10, publish_time: '2026-09-04T00:00:00.000Z', stats,
    ai_verdict: null, ai_tags: null, status: 'collected', local_path: null,
    file_size: null, error: null, retry_count: 0,
    fetched_at: '2026-09-04T00:00:00.000Z', downloaded_at: null,
    author_nickname: '作者'
  }
}

async function setup(videos: VideoRow[], notify = vi.fn()): Promise<{ table: HTMLElement; notify: ReturnType<typeof vi.fn> }> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([task])
  vi.mocked(window.api.getTaskStats).mockResolvedValue({ ...taskStats, total: videos.length, collected: videos.length })
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)
  render(<TaskList notify={notify} />)
  fireEvent.click(await screen.findByRole('button', { name: '展开' }))
  return { table: await screen.findByTestId('video-table'), notify }
}

function orderedTitles(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll('tbody tr[data-id]')).map(row =>
    row.querySelector('td:nth-child(2) > span')?.textContent ?? ''
  )
}

describe('任务视频评论数', () => {
  beforeEach(() => { installFakeApi() })

  it('旧数据和损坏stats显示未知，真实0与非零评论分别显示', async () => {
    const { table } = await setup([
      video(1, '未知评论', '{}'),
      video(2, '损坏统计', '{'),
      video(3, '零评论', JSON.stringify({ likes: 3, comments: 0 })),
      video(4, '二十五评论', JSON.stringify({ likes: 4, comments: 25 }))
    ])
    const displayed = Array.from(table.querySelectorAll('[data-stat="comments"]')).map(cell => cell.textContent)
    expect(displayed).toEqual(['—', '—', '0', '25'])
  })

  it('评论升降序只比较已知数字，未知值始终排在末尾', async () => {
    const { table } = await setup([
      video(1, '未知评论', '{}'),
      video(2, '二十五评论', JSON.stringify({ comments: 25 })),
      video(3, '零评论', JSON.stringify({ comments: 0 })),
      video(4, '损坏统计', '{')
    ])

    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    expect(orderedTitles(table)).toEqual(['零评论', '二十五评论', '未知评论', '损坏统计'])

    fireEvent.click(screen.getByRole('button', { name: '评论 ↑' }))
    expect(orderedTitles(table)).toEqual(['二十五评论', '零评论', '未知评论', '损坏统计'])
  })
})

describe('任务视频来源链接操作', () => {
  beforeEach(() => { installFakeApi() })

  it('显示来源链接，并可复制链接、作者名和安全打开且不改变行选中', async () => {
    const sourceUrl = 'https://www.douyin.com/video/AW1?from=test'
    const notify = vi.fn()
    const { table } = await setup([video(1, '作品一', JSON.stringify({ comments: 2 }), sourceUrl)], notify)
    const row = table.querySelector('tbody tr[data-id="1"]') as HTMLElement

    const source = within(row).getByTitle(sourceUrl)
    expect(source).toHaveTextContent('www.douyin.com')

    fireEvent.click(row)
    expect(row).toHaveAttribute('data-selected', 'true')

    fireEvent.click(within(row).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalledWith(sourceUrl))
    expect(notify).toHaveBeenCalledWith('链接已复制')
    expect(row).toHaveAttribute('data-selected', 'true')

    fireEvent.click(within(row).getByRole('button', { name: '复制作者名' }))
    await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalledWith('作者'))
    expect(notify).toHaveBeenCalledWith('作者名已复制')
    expect(row).toHaveAttribute('data-selected', 'true')

    fireEvent.click(within(row).getByRole('button', { name: '打开原视频' }))
    await waitFor(() => expect(window.api.openVideoSource).toHaveBeenCalledWith(1))
    expect(row).toHaveAttribute('data-selected', 'true')
  })

  it('链接缺失、复制失败和打开失败都显示可理解的错误', async () => {
    const notify = vi.fn()
    const { table } = await setup([video(1, '作品一', '{}', null)], notify)
    const row = table.querySelector('tbody tr[data-id="1"]') as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: '复制链接' }))
    expect(notify).toHaveBeenCalledWith('作品链接不可用')
    expect(window.api.writeClipboard).not.toHaveBeenCalled()

    vi.mocked(window.api.writeClipboard).mockRejectedValueOnce(new Error('clipboard failed'))
    fireEvent.click(within(row).getByRole('button', { name: '复制作者名' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('复制作者名失败'))

    vi.mocked(window.api.openVideoSource).mockResolvedValueOnce({ ok: false, error: '作品链接不安全或不受支持' })
    fireEvent.click(within(row).getByRole('button', { name: '打开原视频' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('作品链接不安全或不受支持'))
  })
})
