import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import VideoProcessPanel from '../../src/renderer/src/components/VideoProcessPanel'
import type { ProcessState } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 「视频处理」页：状态全部来自主进程的 ProcessState 快照（挂载时拉一次 + 订阅推送），
// 按钮只发指令不猜结果——界面显示的阶段必须和真实处理生命周期一致。

function state(over: Partial<ProcessState> = {}): ProcessState {
  return {
    phase: 'idle', dir: null, total: 0, completed: 0, done: 0, skipped: 0, failed: 0,
    processing: 0, remaining: 0, current: null, items: [], log: [], ...over
  }
}

const RUNNING = state({
  phase: 'running', dir: 'D:/视频', total: 4, completed: 1, done: 1, skipped: 0, failed: 1, processing: 1, remaining: 1,
  current: { name: 'b.mp4', source: { width: 720, height: 1280 }, target: { width: 1080, height: 1920 } },
  items: [
    { path: 'D:/视频/a.mp4', name: 'a.mp4', status: 'done', source: { width: 1280, height: 720 }, target: { width: 1920, height: 1080 } },
    { path: 'D:/视频/b.mp4', name: 'b.mp4', status: 'processing', source: { width: 720, height: 1280 }, target: { width: 1080, height: 1920 } },
    { path: 'D:/视频/c.mp4', name: 'c.mp4', status: 'failed', error: 'ffmpeg_failed' },
    { path: 'D:/视频/d.mp4', name: 'd.mp4', status: 'pending' }
  ],
  log: ['12:00:00 开始处理 D:/视频，共发现 4 个视频', '12:00:05 完成 a.mp4：1280×720 → 1920×1080，原片已备份为 a.original.mp4']
})

let pushState: ((s: ProcessState) => void) | null = null

beforeEach(() => {
  installFakeApi()
  pushState = null
  vi.mocked(window.api.onProcessState).mockImplementation(cb => { pushState = cb; return () => { pushState = null } })
})

describe('VideoProcessPanel', () => {
  it('空闲：说明输出策略（临时文件 + 原片备份），开始按钮需先选文件夹', async () => {
    const { container } = render(<VideoProcessPanel />)
    await waitFor(() => expect(window.api.getProcessState).toHaveBeenCalled())
    const text = container.textContent ?? ''
    expect(text).toContain('.original.mp4')
    expect(text).toContain('临时文件')
    expect(text).toContain('1080×1920')
    expect(text).toContain('1920×1080')
    expect(screen.getByTestId('process-phase').textContent).toBe('未开始')
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '暂停' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
  })

  it('「浏览…」选文件夹后填入输入框，「开始处理」把该路径交给主进程；失败原因用 notify 反馈', async () => {
    vi.mocked(window.api.pickVideoDir).mockResolvedValue('D:/视频')
    vi.mocked(window.api.processStart).mockResolvedValue({ ok: false, error: '文件夹不存在' })
    const notify = vi.fn()
    render(<VideoProcessPanel notify={notify} />)
    fireEvent.click(await screen.findByRole('button', { name: '浏览…' }))
    await waitFor(() => expect((screen.getByLabelText('待处理文件夹') as HTMLInputElement).value).toBe('D:/视频'))
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    expect(window.api.processStart).toHaveBeenCalledWith('D:/视频')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('无法开始：文件夹不存在'))
  })

  it('运行中：统计、当前文件与尺寸、每个文件的状态/错误、运行日志都来自状态快照', async () => {
    vi.mocked(window.api.getProcessState).mockResolvedValue(RUNNING)
    render(<VideoProcessPanel />)
    await screen.findByText('b.mp4', { selector: '[data-current-name]' })
    const stats = screen.getByTestId('process-stats')
    expect(within(stats).getByText('总数').nextElementSibling!.textContent).toBe('4')
    expect(within(stats).getByText('已完成').nextElementSibling!.textContent).toBe('1')
    expect(within(stats).getByText('处理中').nextElementSibling!.textContent).toBe('1')
    expect(within(stats).getByText('失败').nextElementSibling!.textContent).toBe('1')
    expect(within(stats).getByText('剩余').nextElementSibling!.textContent).toBe('1')
    // 当前文件：名字 + 原始尺寸 → 目标尺寸
    const current = screen.getByTestId('process-current')
    expect(current.textContent).toContain('b.mp4')
    expect(current.textContent).toContain('720×1280')
    expect(current.textContent).toContain('1080×1920')
    // 文件表：状态文案与单文件错误
    const rowC = screen.getByText('c.mp4').closest('tr')!
    expect(rowC.textContent).toContain('失败')
    expect(rowC.textContent).toContain('ffmpeg_failed')
    const rowA = screen.getByText('a.mp4').closest('tr')!
    expect(rowA.textContent).toContain('完成')
    expect(rowA.textContent).toContain('1280×720')
    expect(screen.getByText('d.mp4').closest('tr')!.textContent).toContain('等待')
    // 日志
    expect(screen.getByTestId('process-log').textContent).toContain('原片已备份为 a.original.mp4')
    // 阶段文案与按钮可用性
    expect(screen.getByTestId('process-phase').textContent).toBe('处理中')
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '暂停' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled()
  })

  it('暂停/继续/停止按钮各自调主进程；暂停态显示「继续」、说明当前文件跑完才停', async () => {
    vi.mocked(window.api.getProcessState).mockResolvedValue(RUNNING)
    render(<VideoProcessPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }))
    expect(window.api.processPause).toHaveBeenCalled()

    act(() => pushState!(state({ ...RUNNING, phase: 'paused' })))
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull()
    expect(screen.getByTestId('process-phase').textContent).toContain('已暂停')
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(window.api.processResume).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(window.api.processStop).toHaveBeenCalled()
    act(() => pushState!(state({ ...RUNNING, phase: 'stopped', processing: 0, current: null })))
    expect(screen.getByTestId('process-phase').textContent).toBe('已停止')
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '开始处理' })).toBeEnabled() // dir 已填，可重新开始
  })

  it('推送的状态覆盖界面（完成态显示汇总），卸载时退订', async () => {
    vi.mocked(window.api.getProcessState).mockResolvedValue(RUNNING)
    const { unmount } = render(<VideoProcessPanel />)
    await screen.findByText('b.mp4', { selector: '[data-current-name]' })
    act(() => pushState!(state({
      phase: 'finished', dir: 'D:/视频', total: 4, completed: 3, done: 2, skipped: 1, failed: 1, remaining: 0,
      items: RUNNING.items.map(i => (i.status === 'processing' || i.status === 'pending') ? { ...i, status: 'done' as const } : i),
      log: ['12:01:00 全部完成：转码 2，已符合跳过 1，失败 1']
    })))
    expect(screen.getByTestId('process-phase').textContent).toBe('全部完成')
    expect(screen.queryByTestId('process-current')).toBeNull()
    const stats = screen.getByTestId('process-stats')
    expect(within(stats).getByText('已完成').nextElementSibling!.textContent).toBe('3')
    expect(stats.textContent).toContain('跳过 1')
    unmount()
    expect(pushState).toBeNull()
  })
})
