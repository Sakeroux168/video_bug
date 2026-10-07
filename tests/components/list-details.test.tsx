import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import FileManager from '../../src/renderer/src/components/FileManager'
import type { TaskRow, VideoRow, TaskStats, DownloadProgress, FilesTree } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-06 全面检查「界面」D8：标题列太窄、看不到分辨率和大小、下载没有百分比和速度、勾选框不能累加

const task: TaskRow = {
  id: 1, platform: 'douyin', type: 'keyword', query: '猫咪', filters: '{}', status: 'done',
  target_count: 3, fetched_count: 3, auto_download: 1, error: null, created_at: '2026-10-01T00:00:00.000Z', finished_at: null
} as TaskRow
function video(id: number, over: Partial<VideoRow> = {}): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `a${id}`, title: `视频${id}`, author_id: 1, play_addr: null,
    source_url: null, cover_url: null, cover_path: null, original_path: null, normalization_error: null,
    video_width: 0, video_height: 0, duration: 30, publish_time: '2026-10-01T00:00:00.000Z', stats: '{}',
    ai_verdict: null, ai_tags: null, status: 'done', local_path: null, file_size: null, error: null, retry_count: 0,
    fetched_at: '2026-10-01T00:00:00.000Z', downloaded_at: null, author_nickname: '作者', ...over
  } as VideoRow
}
const stats: TaskStats = { total: 3, done: 2, failed: 0, downloading: 1, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 }

async function openTask(videos: VideoRow[]) {
  installFakeApi()
  let onProgress: ((e: DownloadProgress) => void) | null = null
  vi.mocked(window.api.onDownloadProgress).mockImplementation(cb => { onProgress = cb; return () => {} })
  vi.mocked(window.api.listTasks).mockResolvedValue([task])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)
  render(<TaskList notify={() => {}} />)
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('视频1')
  return { fire: (e: DownloadProgress) => act(() => onProgress!(e)), table: screen.getByTestId('video-table') }
}
const row = (table: HTMLElement, id: number) => table.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement

afterEach(() => { vi.restoreAllMocks() })

describe('D8 视频列表', () => {
  it('标题列有最小宽度，不再被操作按钮挤窄；鼠标停上去能看全文', async () => {
    const { table } = await openTask([video(1)])
    const title = row(table, 1).querySelector('[data-col="title"]')!
    expect(title.className).toMatch(/min-w-\[14rem\]/)
    expect(title.querySelector('[title="视频1"]')).toBeTruthy()
  })

  it('有分辨率和大小两列：720×1280、2.4 MB；没有的显示 —', async () => {
    const { table } = await openTask([video(1, { video_width: 720, video_height: 1280, file_size: 2.4 * 1024 * 1024 }), video(2)])
    expect(row(table, 1).textContent).toContain('720×1280')
    expect(row(table, 1).textContent).toContain('2.4 MB')
    expect(row(table, 2).querySelector('[data-col="resolution"]')?.textContent).toBe('—')
    expect(row(table, 2).querySelector('[data-col="size"]')?.textContent).toBe('—')
  })

  it('下载中的视频显示百分比和速度', async () => {
    const { table, fire } = await openTask([video(1), video(2, { status: 'downloading' })])
    fire({ type: 'video:progress', id: 2, received: 450_000, total: 1_000_000, speed: 1.2 * 1024 * 1024 })
    await waitFor(() => expect(row(table, 2).textContent).toContain('45%'))
    expect(row(table, 2).textContent).toContain('1.2 MB/s')
  })

  it('勾选框可以一条条累加（以前勾第二条会把第一条顶掉）', async () => {
    const { table } = await openTask([video(1), video(2), video(3)])
    fireEvent.click(within(row(table, 1)).getByRole('checkbox'))
    fireEvent.click(within(row(table, 2)).getByRole('checkbox'))
    expect(screen.getByRole('button', { name: '删除选中(2)' })).toBeInTheDocument()
    fireEvent.click(within(row(table, 1)).getByRole('checkbox'))
    expect(screen.getByRole('button', { name: '删除选中(1)' })).toBeInTheDocument()
  })
})

describe('D8 文件管理', () => {
  it('勾选框可以累加', async () => {
    installFakeApi()
    const tree: FilesTree = {
      root: { name: '', videoCount: 3, size: 3, dirs: [], files: [{ name: 'a.mp4', size: 1 }, { name: 'b.mp4', size: 1 }, { name: 'c.mp4', size: 1 }] },
      totalSize: 3, downloadDir: 'D:/下载'
    }
    vi.mocked(window.api.getFilesTree).mockResolvedValue(tree)
    render(<FileManager notify={() => {}} />)
    await screen.findByText('a.mp4')
    fireEvent.click(within(screen.getByText('a.mp4').closest('tr')!).getByRole('checkbox'))
    fireEvent.click(within(screen.getByText('b.mp4').closest('tr')!).getByRole('checkbox'))
    expect(within(screen.getByText('a.mp4').closest('tr')!).getByRole('checkbox')).toBeChecked()
    expect(within(screen.getByText('b.mp4').closest('tr')!).getByRole('checkbox')).toBeChecked()
  })
})

describe('N05 视频列表显示收藏数', () => {
  it('有收藏列；不知道的显示 —', async () => {
    const { table } = await openTask([video(1, { stats: '{"likes":10,"collects":12345}' }), video(2, { stats: '{"likes":3}' })])
    expect(row(table, 1).querySelector('[data-stat="collects"]')?.textContent).toBe('1.2w')
    expect(row(table, 2).querySelector('[data-stat="collects"]')?.textContent).toBe('—')
  })
})
