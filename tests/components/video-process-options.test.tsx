import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import VideoProcessPanel from '../../src/renderer/src/components/VideoProcessPanel'
import FileManager from '../../src/renderer/src/components/FileManager'
import type { ProcessState, FilesTree } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-07 视频处理改进（功能 D、界面 P1–P6）：输出方式 / 方向 / 严格档；文件夹不存在就近报错；
// 「用下载目录」；完成后显示汇总和「打开文件夹」、处理前后大小；文件管理里可以直接「统一分辨率」

function state(over: Partial<ProcessState> = {}): ProcessState {
  return {
    phase: 'idle', dir: null, total: 0, completed: 0, done: 0, skipped: 0, failed: 0,
    processing: 0, remaining: 0, current: null, items: [], log: [], ...over
  }
}
let pushState: ((s: ProcessState) => void) | null = null
beforeEach(() => {
  installFakeApi()
  pushState = null
  vi.mocked(window.api.onProcessState).mockImplementation(cb => { pushState = cb; return () => { pushState = null } })
})

describe('视频处理选项', () => {
  it('默认：结果放进「已处理」文件夹、跟原片方向、不用严格档', async () => {
    render(<VideoProcessPanel />)
    fireEvent.change(await screen.findByLabelText('待处理文件夹'), { target: { value: 'D:/视频' } })
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    expect(window.api.processStart).toHaveBeenCalledWith('D:/视频', { mode: 'folder', orientation: 'auto', strict: false })
  })

  it('改成替换原文件 + 强制竖屏 + 严格 H.264', async () => {
    render(<VideoProcessPanel />)
    fireEvent.change(await screen.findByLabelText('待处理文件夹'), { target: { value: 'D:/视频' } })
    fireEvent.click(screen.getByLabelText(/替换原文件/))
    fireEvent.change(screen.getByLabelText('方向'), { target: { value: 'portrait' } })
    fireEvent.click(screen.getByLabelText(/严格 H\.264/))
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    expect(window.api.processStart).toHaveBeenCalledWith('D:/视频', { mode: 'replace', orientation: 'portrait', strict: true })
  })

  it('文件夹不存在：红字就近显示在输入框下面，框标红；改了就消失', async () => {
    vi.mocked(window.api.processStart).mockResolvedValue({ ok: false, error: '文件夹不存在' })
    const notify = vi.fn()
    render(<VideoProcessPanel notify={notify} />)
    const input = await screen.findByLabelText('待处理文件夹')
    fireEvent.change(input, { target: { value: 'D:/没有' } })
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    expect(await screen.findByText('文件夹不存在')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(notify).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'D:/视频' } })
    expect(screen.queryByText('文件夹不存在')).toBeNull()
  })

  it('「用下载目录」一键填好；输入框示例只有一个反斜杠', async () => {
    render(<VideoProcessPanel />)
    const input = await screen.findByLabelText('待处理文件夹')
    expect(input.getAttribute('placeholder')).toBe('例如 D:\\抖音视频')
    fireEvent.click(screen.getByRole('button', { name: '用下载目录' }))
    const { downloadDir } = await window.api.getSettings()
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(downloadDir))
  })

  it('还没开始时不显示一排「0」的统计卡片', async () => {
    render(<VideoProcessPanel />)
    await waitFor(() => expect(window.api.getProcessState).toHaveBeenCalled())
    expect(screen.queryByTestId('process-stats')).toBeNull()
  })

  it('从别的页面带着文件夹进来时自动填好', async () => {
    render(<VideoProcessPanel initialDir="D:/下载/美食" />)
    await waitFor(() => expect((screen.getByLabelText('待处理文件夹') as HTMLInputElement).value).toBe('D:/下载/美食'))
  })

  it('完成后：绿色汇总 +「打开文件夹」；每个文件显示处理前后大小，变大的标出来', async () => {
    render(<VideoProcessPanel />)
    await waitFor(() => expect(pushState).not.toBeNull())
    act(() => pushState!(state({
      phase: 'finished', dir: 'D:/视频', outputDir: 'D:/视频/已处理', total: 3, completed: 3, done: 2, skipped: 1,
      items: [
        { path: 'D:/视频/a.mp4', name: 'a.mp4', status: 'done', sizeBefore: 10 * 1024 * 1024, sizeAfter: 8 * 1024 * 1024 },
        { path: 'D:/视频/b.mp4', name: 'b.mp4', status: 'done', sizeBefore: 10 * 1024 * 1024, sizeAfter: 12 * 1024 * 1024 },
        { path: 'D:/视频/c.mp4', name: 'c.mp4', status: 'skipped', sizeBefore: 5 * 1024 * 1024 }
      ]
    })))
    const banner = screen.getByTestId('process-finished')
    expect(banner.textContent).toContain('处理完成：转码 2、跳过 1、失败 0')
    fireEvent.click(within(banner).getByRole('button', { name: '打开文件夹' }))
    expect(window.api.openDir).toHaveBeenCalledWith('D:/视频/已处理')
    const rowB = screen.getByText('b.mp4').closest('tr')!
    expect(rowB.textContent).toContain('10.0 MB → 12.0 MB')
    expect(rowB.querySelector('[data-bigger]')).toBeTruthy()
    expect(screen.getByText('a.mp4').closest('tr')!.querySelector('[data-bigger]')).toBeNull()
  })
})

describe('文件管理里直接送去处理', () => {
  it('文件夹行有「统一分辨率」，点了把这个文件夹的完整路径交出去', async () => {
    const tree: FilesTree = {
      root: { name: '', videoCount: 2, size: 2, files: [], dirs: [{ name: '美食', videoCount: 2, size: 2, dirs: [], files: [{ name: 'a.mp4', size: 1 }] }] },
      totalSize: 2, downloadDir: 'D:/下载'
    }
    vi.mocked(window.api.getFilesTree).mockResolvedValue(tree)
    const onProcessDir = vi.fn()
    render(<FileManager notify={() => {}} onProcessDir={onProcessDir} />)
    const row = (await screen.findByText('美食')).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '统一分辨率' }))
    expect(onProcessDir).toHaveBeenCalledWith('D:/下载/美食')
  })
})
