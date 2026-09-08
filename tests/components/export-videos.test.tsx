import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import FileManager from '../../src/renderer/src/components/FileManager'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 员工要能把下载好的视频数据导成表格交出去。
// 入口刻意不新建导航页：任务列表导「这一批」，文件管理导「全部已下载」。
// 这里只验入口行为（导出范围、按钮可用性、文件名），CSV 内容由 videos-csv.test.ts 覆盖。

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x' },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'y' }
]

const stats: TaskStats = {
  total: 3, done: 3, failed: 0, downloading: 0,
  pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0
}

function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 3, auto_download: 0,
    error: null, created_at: '2026-09-08T00:00:00.000Z', finished_at: null, ...over
  }
}

function makeVideo(id: number, over: Partial<VideoRow> = {}): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `AW${id}`, title: `标题${id}`,
    author_id: 1, play_addr: 'https://cdn.test/v.mp4',
    source_url: `https://www.douyin.com/video/AW${id}`,
    duration: 12, cover_url: null, cover_path: null, original_path: null,
    normalization_error: null, video_width: 1080, video_height: 1920,
    publish_time: '2026-09-08T00:00:00.000Z',
    stats: JSON.stringify({ likes: 42, comments: 17 }),
    ai_verdict: 'pass', ai_tags: null, status: 'done',
    local_path: `D:\\dl\\标题${id}.mp4`, file_size: 1, error: null, retry_count: 0,
    fetched_at: '2026-09-08T00:00:00.000Z', downloaded_at: '2026-09-08T00:00:00.000Z',
    author_nickname: '张三', ...over
  }
}

/** 捕获点击下载链接时用到的 blob 文本与文件名 */
function captureDownload(): { text: () => Promise<string>; name: () => string } {
  let blob: Blob | null = null
  let name = ''
  // jsdom 没有实现 createObjectURL/revokeObjectURL，spyOn 会直接报 does not exist，只能自己装上
  ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blob = b
    return 'blob:fake'
  }
  ;(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    name = this.download
  })
  return { text: async () => (blob ? await blob.text() : ''), name: () => name }
}

beforeEach(() => {
  installFakeApi()
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
})

describe('任务列表导出表格', () => {
  async function openTask(videos: VideoRow[]): Promise<void> {
    vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
    vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)
    render(<TaskList notify={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '展开' }))
    // 用导出按钮本身作为展开完成的信号：空任务用例里没有任何视频行可等
    await screen.findByRole('button', { name: /导出表格/ })
  }

  it('没选中任何视频 → 按钮导出当前任务全部，数量显示在按钮上', async () => {
    const cap = captureDownload()
    await openTask([makeVideo(1), makeVideo(2), makeVideo(3)])

    const btn = screen.getByRole('button', { name: /导出表格\(3\)/ })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(4) // 表头 + 3 行
    expect(csv).toContain('标题1')
    expect(csv).toContain('标题3')
  })

  it('选中两条 → 只导这两条', async () => {
    const cap = captureDownload()
    await openTask([makeVideo(1), makeVideo(2), makeVideo(3)])

    // 勾选框是排他选中（既有交互），加选要 Ctrl 点行
    fireEvent.click(screen.getByText('标题1').closest('tr')!.querySelector('input[type=checkbox]')!)
    fireEvent.click(screen.getByText('标题2').closest('tr')!, { ctrlKey: true })

    fireEvent.click(screen.getByRole('button', { name: /导出表格\(2\)/ }))
    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv).toContain('标题1')
    expect(csv).not.toContain('标题3')
  })

  it('平台列导出中文显示名，不是 douyin', async () => {
    const cap = captureDownload()
    await openTask([makeVideo(1, { platform: 'kuaishou' })])
    fireEvent.click(screen.getByRole('button', { name: /导出表格/ }))

    const csv = await cap.text()
    expect(csv.split('\r\n')[1].startsWith('快手,')).toBe(true)
  })

  it('导出文件名带日期，扩展名是 .csv', async () => {
    const cap = captureDownload()
    await openTask([makeVideo(1)])
    fireEvent.click(screen.getByRole('button', { name: /导出表格/ }))
    expect(cap.name()).toMatch(/^视频数据-.*\d{4}-\d{2}-\d{2}\.csv$/)
  })

  it('任务一条视频都没有 → 按钮禁用，不产出只有表头的空表', async () => {
    await openTask([])
    expect(screen.getByRole('button', { name: /导出表格\(0\)/ })).toBeDisabled()
  })
})

describe('文件管理导出全部已下载', () => {
  async function openFiles(): Promise<void> {
    vi.mocked(window.api.getFilesTree).mockResolvedValue({
      categories: [], totalSize: 0, downloadDir: 'D:\\dl'
    })
    render(<FileManager notify={() => {}} />)
    await screen.findByRole('button', { name: '刷新' })
  }

  it('跨任务导出所有已下载视频', async () => {
    const cap = captureDownload()
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue([
      makeVideo(1), makeVideo(2, { platform: 'kuaishou', task_id: 7 })
    ])
    await openFiles()

    fireEvent.click(screen.getByRole('button', { name: /导出全部已下载/ }))
    await waitFor(async () => expect(await cap.text()).toContain('标题2'))
    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv).toContain('抖音,')
    expect(csv).toContain('快手,')
  })

  it('一条已下载都没有 → 提示而不是产出空表', async () => {
    const notify = vi.fn()
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue([])
    vi.mocked(window.api.getFilesTree).mockResolvedValue({ categories: [], totalSize: 0, downloadDir: 'D:\\dl' })
    render(<FileManager notify={notify} />)
    await screen.findByRole('button', { name: '刷新' })

    fireEvent.click(screen.getByRole('button', { name: /导出全部已下载/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/没有已下载/)))
  })
})

// 员工在文件管理里点进「搞笑」，想导的就是这个品类的表，而不是全部。
// 范围一律按"文件在不在这个文件夹底下"判定——归档层级可配，目录结构会变，
// 按路径判永远和这一页看到的一致。
describe('文件管理按品类/作者导出', () => {
  const DIR = 'D:\\dl'
  const TREE = {
    downloadDir: DIR,
    totalSize: 0,
    categories: [
      { name: '搞笑', videoCount: 2, size: 100, authors: [
        { name: '张三', videoCount: 1, size: 50 },
        { name: '李四', videoCount: 1, size: 50 }
      ] },
      { name: '美食', videoCount: 1, size: 50, authors: [{ name: '王五', videoCount: 1, size: 50 }] }
    ]
  }

  const ROWS = [
    makeVideo(1, { title: '搞笑张三', local_path: `${DIR}\\搞笑\\张三\\竖屏\\一分钟内\\a.mp4` }),
    makeVideo(2, { title: '搞笑李四', local_path: `${DIR}\\搞笑\\李四\\竖屏\\一分钟内\\b.mp4` }),
    makeVideo(3, { title: '美食王五', local_path: `${DIR}\\美食\\王五\\竖屏\\一分钟内\\c.mp4` })
  ]

  async function openFileManager(notify = (): void => {}): Promise<void> {
    vi.mocked(window.api.getFilesTree).mockResolvedValue(TREE as never)
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue(ROWS)
    render(<FileManager notify={notify} />)
    await screen.findByText('搞笑')
  }

  /** 进入某个品类的二级页 */
  async function enterCategory(name: string): Promise<void> {
    fireEvent.click(screen.getByText(name).closest('tr')!)
    await screen.findByText(`当前品类：${name}`)
  }

  it('进入品类后「导出本品类」只导该品类下的视频', async () => {
    const cap = captureDownload()
    await openFileManager()
    await enterCategory('搞笑')

    fireEvent.click(screen.getByRole('button', { name: '导出本品类' }))
    await waitFor(async () => expect(await cap.text()).toContain('搞笑张三'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(3) // 表头 + 2 行
    expect(csv).toContain('搞笑李四')
    expect(csv).not.toContain('美食王五')
  })

  it('作者行的「导出」只导那一个作者', async () => {
    const cap = captureDownload()
    await openFileManager()
    await enterCategory('搞笑')

    const row = screen.getByText('张三').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '导出' }))
    await waitFor(async () => expect(await cap.text()).toContain('搞笑张三'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).not.toContain('搞笑李四')
  })

  it('品类列表页「导出选中品类」只导勾中的', async () => {
    const cap = captureDownload()
    await openFileManager()

    fireEvent.click(screen.getByText('美食').closest('tr')!.querySelector('input[type=checkbox]')!)
    fireEvent.click(screen.getByRole('button', { name: /导出选中品类\(1\)/ }))
    await waitFor(async () => expect(await cap.text()).toContain('美食王五'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).not.toContain('搞笑张三')
  })

  it('一个品类都没勾 → 按钮禁用', async () => {
    await openFileManager()
    expect(screen.getByRole('button', { name: /导出选中品类\(0\)/ })).toBeDisabled()
  })

  it('该品类磁盘上有文件夹但库里没有对应记录 → 明说没有可导出的，不甩空表', async () => {
    const notify = vi.fn()
    vi.mocked(window.api.getFilesTree).mockResolvedValue(TREE as never)
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue([])
    render(<FileManager notify={notify} />)
    await screen.findByText('搞笑')
    await enterCategory('搞笑')

    fireEvent.click(screen.getByRole('button', { name: '导出本品类' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/没有已下载的视频/)))
  })
})
