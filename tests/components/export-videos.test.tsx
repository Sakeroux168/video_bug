import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import FileManager from '../../src/renderer/src/components/FileManager'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import { buildAuthorsCsv } from '../../src/renderer/src/components/authorsCsv'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 员工要能把下载好的视频数据导成表格交出去。
// 入口刻意不新建导航页：任务列表导「这一批」，文件管理导「全部已下载」。
// 这里只验入口行为（导出范围、按钮可用性、文件名），CSV 内容由 videos-csv.test.ts 覆盖。

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'y', taskReady: true }
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

/** 捕获交给主进程的文本和文件名，原有导出范围/内容断言保持不变 */
function captureDownload(): { text: () => Promise<string>; name: () => string } {
  let csv = ''
  let name = ''
  vi.mocked(window.api.exportCsv).mockImplementation(async input => {
    csv = input.csv
    name = input.fileName
    return { ok: true, fileName: name, path: `C:\\Users\\tester\\Downloads\\${name}` }
  })
  return { text: async () => csv, name: () => name }
}

beforeEach(() => {
  installFakeApi()
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
})

describe('导出结果与合并任务', () => {
  it('三处导出只走 IPC，成功提示真实文件名与定位按钮', async () => {
    const author = { id: 1, platform: 'douyin', nickname: '中文作者', sec_uid: 'sec', home_url: 'https://www.douyin.com/user/sec', category: '美食', first_seen: '', last_seen: '', video_count: 1, crawled: 0 }
    vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
    vi.mocked(window.api.listTaskVideos).mockResolvedValue([makeVideo(1)])
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue([makeVideo(1)])
    vi.mocked(window.api.listAuthors).mockResolvedValue([author] as never)
    vi.mocked(window.api.exportCsv).mockResolvedValue({ ok: true, fileName: '重名后的表 (1).csv', path: 'C:\\Downloads\\重名后的表 (1).csv' })
    const createElement = vi.spyOn(document, 'createElement')
    const notify = vi.fn()
    const components = [<TaskList notify={notify} />, <FileManager notify={notify} />, <AuthorCollection notify={notify} />]
    for (let i = 0; i < components.length; i++) {
      const view = render(components[i])
      if (i === 0) fireEvent.click(await screen.findByRole('button', { name: '展开' }))
      const btn = await screen.findByRole('button', { name: i === 0 ? /导出表格/ : i === 1 ? '导出全部已下载' : '导出 CSV' })
      await waitFor(() => expect(btn).toBeEnabled())
      createElement.mockClear()
      fireEvent.click(btn)
      await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalledTimes(i + 1))
      await waitFor(() => expect(notify).toHaveBeenCalledWith('已导出 1 条 → 重名后的表 (1).csv', expect.objectContaining({ duration: 15000, action: expect.objectContaining({ label: '打开所在文件夹' }) })))
      const options = notify.mock.calls.at(-1)![1]
      await options.action.onClick()
      expect(window.api.revealExport).toHaveBeenLastCalledWith('C:\\Downloads\\重名后的表 (1).csv')
      if (i === 2) expect(vi.mocked(window.api.exportCsv).mock.calls.at(-1)![0].csv).toBe(buildAuthorsCsv([author] as never))
      expect(createElement.mock.calls.filter(([tag]) => String(tag) === 'a')).toHaveLength(0)
      notify.mockClear()
      view.unmount()
    }
    createElement.mockRestore()
  })
  it('写文件失败及 IPC 异常有中文提示，不给成功提示或定位按钮', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([{ id: 1, platform: 'douyin', nickname: '中文作者' }] as never)
    const notify = vi.fn()
    render(<AuthorCollection notify={notify} />)
    const btn = await screen.findByRole('button', { name: '导出 CSV' })
    await waitFor(() => expect(btn).toBeEnabled())
    vi.mocked(window.api.exportCsv).mockResolvedValue({ ok: false, error: '下载文件夹空间不足，请腾出空间后重试' })
    fireEvent.click(btn)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('下载文件夹空间不足，请腾出空间后重试'))
    vi.mocked(window.api.exportCsv).mockRejectedValue(new Error('IPC gone'))
    fireEvent.click(btn)
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/导出失败.*重试/)))
    expect(notify.mock.calls.some(([text]) => text.startsWith('已导出'))).toBe(false)
  })
  it('未展开任务也能多选合并，原有八列不变，仅末尾追加任务来源', async () => {
    const cap = captureDownload()
    vi.mocked(window.api.listTasks).mockResolvedValue([
      makeTask({ query: '美食,选题' }), makeTask({ id: 2, platform: 'kuaishou', type: 'author', query: 'sec2', author_nickname: '李四' }), makeTask({ id: 3, query: '不选的任务' })
    ])
    vi.mocked(window.api.listTaskVideos).mockImplementation(async id => [makeVideo(id, { task_id: id, platform: id === 2 ? 'kuaishou' : 'douyin' })])
    render(<TaskList notify={() => {}} />)
    const first = await screen.findByRole('checkbox', { name: '选择任务 1' })
    expect(screen.getByRole('button', { name: /合并导出选中任务/ })).toBeDisabled()
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择任务 2' }))
    expect(screen.getAllByRole('button', { name: '展开' })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '合并导出选中任务(2)' }))
    await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalledOnce())
    const csv = await cap.text()
    expect(csv.split('\r\n')[0]).toBe('平台,作者,标题,作品链接,点赞,评论,时长(秒),本地文件名,任务（平台 / 类型 / 关键词或作者）')
    expect(csv.split('\r\n')[1]).toBe('抖音,张三,标题1,https://www.douyin.com/video/AW1,42,17,12,标题1.mp4,"抖音 / 关键词 / 美食,选题"')
    expect(csv.split('\r\n')[2]).toBe('快手,张三,标题2,https://www.douyin.com/video/AW2,42,17,12,标题2.mp4,快手 / 作者 / 李四')
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(window.api.listTaskVideos).not.toHaveBeenCalledWith(3)
  })
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

    // 勾一条，再 Ctrl 点行加选（2026-10-06 起勾选框本身也能累加，见 list-details.test.tsx）
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
  const EMPTY_ROOT = { name: '', videoCount: 0, size: 0, dirs: [], files: [] }
  async function openFiles(): Promise<void> {
    vi.mocked(window.api.getFilesTree).mockResolvedValue({
      root: EMPTY_ROOT, totalSize: 0, downloadDir: 'D:\\dl'
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
    vi.mocked(window.api.getFilesTree).mockResolvedValue({ root: EMPTY_ROOT, totalSize: 0, downloadDir: 'D:\\dl' })
    render(<FileManager notify={notify} />)
    await screen.findByRole('button', { name: '刷新' })

    fireEvent.click(screen.getByRole('button', { name: /导出全部已下载/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/没有已下载/)))
  })
})

// 员工在文件管理里点进「搞笑」，想导的就是这个文件夹的表，而不是全部。
// 范围一律按"文件在不在这个文件夹底下"判定——归档层级可配，目录结构会变，
// 按路径判永远和这一页看到的一致。
describe('文件管理按文件夹导出', () => {
  const DIR = 'D:\\dl'
  const leaf = (name: string, files: string[]) => ({
    name, videoCount: files.length, size: 50 * files.length, dirs: [], files: files.map(f => ({ name: f, size: 50 }))
  })
  const TREE = {
    downloadDir: DIR,
    totalSize: 0,
    root: {
      name: '', videoCount: 3, size: 150, files: [],
      dirs: [
        { name: '搞笑', videoCount: 2, size: 100, files: [], dirs: [leaf('张三', ['a.mp4']), leaf('李四', ['b.mp4'])] },
        { name: '美食', videoCount: 1, size: 50, files: [], dirs: [leaf('王五', ['c.mp4'])] }
      ]
    }
  }

  const ROWS = [
    // 路径与上面的树一致（仅品类/作者两层）；文件管理按路径前缀筛，所以树和库里的路径必须对得上
    makeVideo(1, { title: '搞笑张三', local_path: `${DIR}\\搞笑\\张三\\a.mp4` }),
    makeVideo(2, { title: '搞笑李四', local_path: `${DIR}\\搞笑\\李四\\b.mp4` }),
    makeVideo(3, { title: '美食王五', local_path: `${DIR}\\美食\\王五\\c.mp4` })
  ]

  async function openFileManager(notify = (): void => {}): Promise<void> {
    vi.mocked(window.api.getFilesTree).mockResolvedValue(TREE as never)
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue(ROWS)
    render(<FileManager notify={notify} />)
    await screen.findByText('搞笑')
  }

  /** 进入某个顶层文件夹 */
  async function enterCategory(name: string): Promise<void> {
    fireEvent.click(screen.getByText(name).closest('tr')!)
    await screen.findByText(`当前文件夹：${name}`)
  }

  it('进入文件夹后「导出当前文件夹」只导该文件夹下的视频', async () => {
    const cap = captureDownload()
    await openFileManager()
    await enterCategory('搞笑')

    fireEvent.click(screen.getByRole('button', { name: '导出当前文件夹' }))
    await waitFor(async () => expect(await cap.text()).toContain('搞笑张三'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(3) // 表头 + 2 行
    expect(csv).toContain('搞笑李四')
    expect(csv).not.toContain('美食王五')
  })

  it('子文件夹行的「导出」只导那一个文件夹', async () => {
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

  it('「导出选中」只导勾中的文件夹', async () => {
    const cap = captureDownload()
    await openFileManager()

    fireEvent.click(screen.getByText('美食').closest('tr')!.querySelector('input[type=checkbox]')!)
    fireEvent.click(screen.getByRole('button', { name: /导出选中\(1\)/ }))
    await waitFor(async () => expect(await cap.text()).toContain('美食王五'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).not.toContain('搞笑张三')
  })

  it('勾中单个视频文件 → 只导那一条', async () => {
    const cap = captureDownload()
    await openFileManager()
    await enterCategory('搞笑')
    fireEvent.click(screen.getByText('张三').closest('tr')!)
    await screen.findByText('a.mp4')

    fireEvent.click(screen.getByText('a.mp4').closest('tr')!.querySelector('input[type=checkbox]')!)
    fireEvent.click(screen.getByRole('button', { name: /导出选中\(1\)/ }))
    await waitFor(async () => expect(await cap.text()).toContain('搞笑张三'))

    const csv = await cap.text()
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).not.toContain('搞笑李四')
  })

  it('一项都没勾 → 按钮禁用', async () => {
    await openFileManager()
    expect(screen.getByRole('button', { name: /导出选中\(0\)/ })).toBeDisabled()
  })

  it('该文件夹磁盘上存在但库里没有对应记录 → 明说没有可导出的，不甩空表', async () => {
    const notify = vi.fn()
    vi.mocked(window.api.getFilesTree).mockResolvedValue(TREE as never)
    vi.mocked(window.api.listDownloadedVideos).mockResolvedValue([])
    render(<FileManager notify={notify} />)
    await screen.findByText('搞笑')
    await enterCategory('搞笑')

    fireEvent.click(screen.getByRole('button', { name: '导出当前文件夹' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/没有已下载的视频/)))
  })
})
