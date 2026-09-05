import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// P0 补测（决策审查 2026-08-05 缺口 1+4，修正版范围）：
// a) 全选/本页全选勾选框与 indeterminate 中间态（TaskList.tsx 头部 checkbox ref 回调，原无任何断言）；
// b) 批量「下载选中/取消选中/重试选中失败」三个按钮的选中态过滤矩阵（暂停/继续已由
//    batch-pause-resume.test.tsx 覆盖计数，删除选中已由 video-delete.test.tsx 覆盖调用，此处合并全矩阵断言）；
// c) 行内按钮组合矩阵（各 status 只显示对应按钮）。
// 跨页选中集合本身已测（batch-pause-resume.test.tsx 第 3 条），此处只补「全选 → 翻页 → 第 2 页勾选」的计数衔接。

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
    author_id: null, play_addr: null, source_url: null, cover_url: null, cover_path: null,
    original_path: null, normalization_error: null,
    video_width: 0, video_height: 0, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
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
  return screen.getByTestId('video-table')
}

/** ctrl+点击行 = 切换选中（不清其它），与 selection.test.tsx 手势一致 */
function toggleRow(containerDiv: HTMLElement, id: number): void {
  const tr = containerDiv.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement
  fireEvent.mouseDown(tr, { ctrlKey: true })
  fireEvent.mouseUp(tr, { ctrlKey: true })
  fireEvent.click(tr, { ctrlKey: true })
}

/** 视频表格头部「本页全选」勾选框（checked + indeterminate 由 ref 回调维护） */
function headerCheckbox(): HTMLInputElement {
  // 从视频表容器内取：外层任务表 thead 里也有一个 disabled 占位勾选框，
  // 全局 getByTestId('select-all') 会歧义（多任务展开时更甚），必须带容器作用域。
  return screen.getByTestId('video-table')
    .querySelector('[data-testid="select-all"]') as HTMLInputElement
}

/** 行内所有交互元素文本（button/a），用于按钮**文案**契约断言（顺序即 DOM 顺序） */
function rowControls(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('button, a')).map(el => el.textContent ?? '')
}

/** 行内所有交互元素的 data-action（顺序即 DOM 顺序）。
 *  P0 脱敏：能力矩阵改用 action 断言，与按钮文案解耦——文案另有一条契约单独锁，
 *  两者分别回答「这一行提供了什么能力」与「按钮叫什么」。 */
function rowActions(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('button, a')).map(el => el.getAttribute('data-action') ?? '')
}

/** 按 data-id 定位视频行；filtered 行无 data-id，用标题文本定位 */
function rowOf(containerDiv: HTMLElement, id: number): HTMLElement {
  const row = containerDiv.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement
  if (row) return row
  return Array.from(containerDiv.querySelectorAll('tbody tr'))
    .find(tr => tr.textContent?.includes(`视频${id}`)) as HTMLElement
}

describe('批量操作矩阵（全选/indeterminate + 批量按钮 + 行内按钮）', () => {
  beforeEach(() => {
    installFakeApi()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('全选/indeterminate：空态未选 → 部分选中中间态 → 全选 → 再点清空', async () => {
    const c = await setup(Array.from({ length: 7 }, (_, i) => makeVideo(i + 1)))

    // 空态未选：未勾且非中间态
    let cb = headerCheckbox()
    expect(cb.checked).toBe(false)
    expect(cb.indeterminate).toBe(false)

    // 部分选中 → indeterminate 中间态（DOM 属性断言）
    toggleRow(c, 1)
    cb = headerCheckbox()
    expect(cb.indeterminate).toBe(true)
    expect(cb.checked).toBe(false)

    // 点全选 → 本页全部勾选，取消中间态
    fireEvent.click(cb)
    cb = headerCheckbox()
    expect(cb.checked).toBe(true)
    expect(cb.indeterminate).toBe(false)
    for (let i = 1; i <= 7; i++) {
      const rowCb = rowOf(c, i).querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(rowCb.checked).toBe(true)
    }

    // 再点全选 → 清空本页勾选
    fireEvent.click(cb)
    cb = headerCheckbox()
    expect(cb.checked).toBe(false)
    expect(cb.indeterminate).toBe(false)
    for (let i = 1; i <= 7; i++) {
      const rowCb = rowOf(c, i).querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(rowCb.checked).toBe(false)
    }
  })

  it('全选排除 filtered 行：勾选框 disabled 且不计入批量计数', async () => {
    const c = await setup([
      makeVideo(1, { status: 'collected' }),
      makeVideo(2, { status: 'filtered' })
    ])

    fireEvent.click(headerCheckbox())

    // 全选态 = 可选行 1 已选；filtered 行勾选框 disabled 且未勾
    const cb = headerCheckbox()
    expect(cb.checked).toBe(true)
    const filteredCb = rowOf(c, 2).querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(filteredCb.disabled).toBe(true)
    expect(filteredCb.checked).toBe(false)

    // 批量计数只含可选行
    expect(screen.getByText('删除选中(1)')).toBeInTheDocument()
    expect(screen.queryByText('删除选中(2)')).not.toBeInTheDocument()
  })

  it('全选跨页：第 1 页全选 → 翻页 → 第 2 页部分勾选 → 批量计数为两页合计', async () => {
    // 55 条（> 每页 50）→ 第 1 页 50 条、第 2 页 5 条
    const videos = Array.from({ length: 55 }, (_, i) => makeVideo(i + 1, { status: 'collected' }))
    const c = await setup(videos)

    // 第 1 页全选
    fireEvent.click(headerCheckbox())
    expect(headerCheckbox().checked).toBe(true)

    fireEvent.click(screen.getByText('下一页'))
    // 第 2 页本页未选 → 头勾选框未勾且非中间态
    let cb = headerCheckbox()
    expect(cb.checked).toBe(false)
    expect(cb.indeterminate).toBe(false)

    // 第 2 页勾选 1 条 → 头勾选框中间态，批量计数 = 两页合计 51
    toggleRow(c, 51)
    cb = headerCheckbox()
    expect(cb.indeterminate).toBe(true)
    expect(cb.checked).toBe(false)

    const btn = screen.getByText('下载选中(51)') as HTMLButtonElement
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    expect(window.api.downloadVideos).toHaveBeenCalledWith(Array.from({ length: 51 }, (_, i) => i + 1))
  })

  it('批量按钮状态过滤矩阵：六按钮各自计数 N 与调用参数', async () => {
    await setup([
      makeVideo(1, { status: 'pending' }),
      makeVideo(2, { status: 'downloading' }),
      makeVideo(3, { status: 'paused' }),
      makeVideo(4, { status: 'failed' }),
      makeVideo(5, { status: 'collected' }),
      makeVideo(6, { status: 'cancelled' }),
      makeVideo(7, { status: 'done' })
    ])
    fireEvent.click(headerCheckbox()) // 全选 1..7（done 不属于下载集，应被排除）

    // 计数 = selected ∩ 各自状态集
    expect(screen.getByText('下载选中(3)')).toBeEnabled()     // collected/cancelled/failed = 4,5,6
    expect(screen.getByText('取消选中(2)')).toBeEnabled()     // pending/downloading = 1,2
    expect(screen.getByText('暂停选中(2)')).toBeEnabled()     // pending/downloading = 1,2
    expect(screen.getByText('继续选中(1)')).toBeEnabled()     // paused = 3
    expect(screen.getByText('重试选中失败(1)')).toBeEnabled() // failed = 4
    expect(screen.getByText('删除选中(7)')).toBeEnabled()     // 本任务全部状态

    // 点击各按钮 → 对应批量接口收到过滤后的 id 列表
    fireEvent.click(screen.getByText('下载选中(3)'))
    expect(window.api.downloadVideos).toHaveBeenCalledWith([4, 5, 6])
    fireEvent.click(screen.getByText('取消选中(2)'))
    expect(window.api.cancelVideos).toHaveBeenCalledWith([1, 2])
    fireEvent.click(screen.getByText('暂停选中(2)'))
    expect(window.api.pauseVideos).toHaveBeenCalledWith([1, 2])
    fireEvent.click(screen.getByText('继续选中(1)'))
    expect(window.api.resumeVideos).toHaveBeenCalledWith([3])
    fireEvent.click(screen.getByText('重试选中失败(1)'))
    expect(window.api.retryVideos).toHaveBeenCalledWith([4])
    fireEvent.click(screen.getByText('删除选中(7)'))
    expect(window.confirm).toHaveBeenCalledWith('确定删除选中的 7 个视频？将同时删除本地文件')
    expect(window.api.deleteVideos).toHaveBeenCalledWith([1, 2, 3, 4, 5, 6, 7])
  })

  it('批量按钮空集禁用：0 计数禁用且点击不调接口（删除选中随勾选归零）', async () => {
    const c = await setup([
      makeVideo(1, { status: 'done' }),
      makeVideo(2, { status: 'done' })
    ])

    toggleRow(c, 1) // 只选 done 行 → 不属于任何下载/取消/暂停/继续/重试集
    for (const text of ['下载选中(0)', '取消选中(0)', '暂停选中(0)', '继续选中(0)', '重试选中失败(0)']) {
      const btn = screen.getByText(text) as HTMLButtonElement
      expect(btn).toBeDisabled()
    }
    expect(screen.getByText('删除选中(1)')).toBeEnabled()

    fireEvent.click(screen.getByText('下载选中(0)'))
    expect(window.api.downloadVideos).not.toHaveBeenCalled()

    // 再点已选行 → 清空选择 → 删除选中也归零禁用
    toggleRow(c, 1)
    const delBtn = screen.getByText('删除选中(0)') as HTMLButtonElement
    expect(delBtn).toBeDisabled()
    fireEvent.click(delBtn)
    expect(window.api.deleteVideos).not.toHaveBeenCalled()
  })

  it('搜索过滤后批量下载：勾选可见行 → 参数为过滤后 id（非全列表）', async () => {
    const c = await setup(Array.from({ length: 10 }, (_, i) => makeVideo(i + 1, { status: 'collected' })))
    // 搜索词「视频1」→ 只匹配 视频1 / 视频10 两条可见（与 status='filtered' 行是两套机制）
    fireEvent.change(screen.getByPlaceholderText('搜索标题/作者'), { target: { value: '视频1' } })

    // 全选 = 过滤后的可见行；批量计数与调用参数都只含这 2 条
    fireEvent.click(headerCheckbox())
    const btn = screen.getByText('下载选中(2)') as HTMLButtonElement
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    expect(window.api.downloadVideos).toHaveBeenCalledWith([1, 10])
  })

  it('行内按钮组合矩阵：每行只显示对应按钮 + 代表性按钮点击调接口', async () => {
    const c = await setup([
      makeVideo(1, { status: 'pending' }),
      makeVideo(2, { status: 'downloading' }),
      makeVideo(3, { status: 'paused' }),
      makeVideo(4, { status: 'failed' }),
      makeVideo(5, { status: 'collected' }),
      makeVideo(6, { status: 'cancelled' }),
      makeVideo(7, { status: 'done', local_path: 'D:\\videos\\x.mp4' }),
      makeVideo(8, { status: 'done', local_path: null }),
      makeVideo(9, { status: 'filtered' })
    ])

    // 存在性组合（顺序 = DOM 顺序：状态操作/打开原视频/复制链接/复制作者名/删除）
    expect(rowActions(rowOf(c, 1))).toEqual(['pause', 'cancel', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 2))).toEqual(['pause', 'cancel', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 3))).toEqual(['resume', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 4))).toEqual(['download', 'retry', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 5))).toEqual(['download', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 6))).toEqual(['download', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 7))).toEqual(['locate', 'source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 8))).toEqual(['source', 'copy-source', 'copy-author', 'delete'])
    expect(rowActions(rowOf(c, 9))).toEqual([]) // filtered 行无任何操作元素

    // 代表性按钮点击 → 对应接口
    const btnIn = (row: HTMLElement, label: string) =>
      Array.from(row.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement
    fireEvent.click(btnIn(rowOf(c, 4), '下载'))
    expect(window.api.downloadVideos).toHaveBeenCalledWith([4])
    fireEvent.click(btnIn(rowOf(c, 4), '重试'))
    expect(window.api.retryVideos).toHaveBeenCalledWith([4])
    fireEvent.click(btnIn(rowOf(c, 1), '暂停'))
    expect(window.api.pauseVideos).toHaveBeenCalledWith([1])
    fireEvent.click(btnIn(rowOf(c, 3), '继续'))
    expect(window.api.resumeVideos).toHaveBeenCalledWith([3])
    fireEvent.click(btnIn(rowOf(c, 2), '取消'))
    expect(window.api.cancelVideos).toHaveBeenCalledWith([2])
    fireEvent.click(btnIn(rowOf(c, 7), '定位'))
    expect(window.api.locateVideo).toHaveBeenCalledWith('D:\\videos\\x.mp4')
  })

  // P0 脱敏配套：上面的能力矩阵改用 data-action 断言后，按钮**文案**不再被任何测试覆盖。
  // 文案是用户直接看到的东西，也是 useMarqueeSelect 的 closest('button, a, input') 守卫
  // 赖以生效的原生 button/a 结构的一部分。这里把原来的文案数组原样保留成独立契约——
  // 能力（做什么）与叫法（显示什么）分开测，断言总数只增不减。
  it('⑧ 行内按钮文案契约（与能力矩阵一一对应）', async () => {
    const c = await setup([
      makeVideo(1, { status: 'pending' }),
      makeVideo(2, { status: 'downloading' }),
      makeVideo(3, { status: 'paused' }),
      makeVideo(4, { status: 'failed' }),
      makeVideo(5, { status: 'collected' }),
      makeVideo(6, { status: 'cancelled' }),
      makeVideo(7, { status: 'done', local_path: 'D:/videos/x.mp4' }),
      makeVideo(8, { status: 'done', local_path: null }),
      makeVideo(9, { status: 'filtered' })
    ])

    expect(rowControls(rowOf(c, 1))).toEqual(['暂停', '取消', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 2))).toEqual(['暂停', '取消', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 3))).toEqual(['继续', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 4))).toEqual(['下载', '重试', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 5))).toEqual(['下载', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 6))).toEqual(['下载', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 7))).toEqual(['定位', '打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 8))).toEqual(['打开原视频', '复制链接', '复制作者名', '删除'])
    expect(rowControls(rowOf(c, 9))).toEqual([]) // filtered 行无任何操作元素
  })
})
