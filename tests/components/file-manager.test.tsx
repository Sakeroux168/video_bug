import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileManager from '../../src/renderer/src/components/FileManager'
import type { FilesTree } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// Task 4 文件管理 UI：一级品类表 → 点行进二级作者表 → 返回；行删除/批量删除都走 confirm + api + 刷新

function makeTree(): FilesTree {
  return {
    categories: [
      {
        name: '美食', videoCount: 3, size: 3 * 1024 * 1024,
        authors: [
          { name: '作者A', videoCount: 2, size: 2 * 1024 * 1024 },
          { name: '作者B', videoCount: 1, size: 1 * 1024 * 1024 }
        ]
      },
      { name: '旅行', videoCount: 1, size: 0.5 * 1024 * 1024, authors: [{ name: '作者C', videoCount: 1, size: 0.5 * 1024 * 1024 }] }
    ],
    totalSize: 3.5 * 1024 * 1024,
    downloadDir: 'D:/下载'
  }
}

describe('FileManager（文件管理 tab）', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function setup(notify: (t: string) => void = () => {}): Promise<void> {
    installFakeApi()
    vi.mocked(window.api.getFilesTree).mockResolvedValue(makeTree())
    render(<FileManager notify={notify} />)
    await screen.findByText('美食')
  }

  it('一级页：品类表格展示 品类名｜视频数｜总大小(MB)，空状态提示', async () => {
    installFakeApi()
    vi.mocked(window.api.getFilesTree).mockResolvedValue({ categories: [], totalSize: 0, downloadDir: 'D:/下载' })
    render(<FileManager notify={() => {}} />)
    await screen.findByText('下载目录还没有品类文件夹')
    vi.mocked(window.api.getFilesTree).mockResolvedValue(makeTree())
    fireEvent.click(screen.getByText('刷新'))
    await screen.findByText('美食')
    // 大小格式化：3MB → 3.0；0.5MB → 0.5
    expect(screen.getByText('3.0')).toBeTruthy()
    expect(screen.getByText('0.5')).toBeTruthy()
  })

  it('点品类行进入二级页（作者表格 + 面包屑），返回按钮回一级页', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    expect(screen.getByText('作者B')).toBeTruthy()
    expect(screen.getByText('← 返回品类列表')).toBeTruthy()
    fireEvent.click(screen.getByText('← 返回品类列表'))
    await screen.findByText('旅行') // 一级页表格回来了
    expect(screen.queryByText('作者A')).toBeNull()
  })

  it('行「删除」品类：confirm 确认 → deleteFileCategory(name) → 刷新', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileCategory).mockResolvedValue({ ok: true, deleted: 2, filesRemoved: true })
    const row = screen.getByText('美食').closest('tr')!
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('美食'))
    expect(window.api.deleteFileCategory).toHaveBeenCalledWith('美食')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 2 条'))
    expect(window.api.getFilesTree).toHaveBeenCalled() // 删除后刷新
  })

  it('行「删除」：confirm 取消则不调用', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await setup()
    const row = screen.getByText('美食').closest('tr')!
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    expect(window.api.deleteFileCategory).not.toHaveBeenCalled()
  })

  it('批量「删除选中品类(N)」：勾选后 confirm → 逐个调 deleteFileCategory', async () => {
    await setup()
    const cb = screen.getByText('美食').closest('tr')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(cb)
    const btn = screen.getByText('删除选中品类(1)')
    fireEvent.click(btn)
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('品类'))
    expect(window.api.deleteFileCategory).toHaveBeenCalledWith('美食')
    expect(window.api.getFilesTree).toHaveBeenCalled()
  })

  it('未勾选时批量删除按钮禁用', async () => {
    await setup()
    const btn = screen.getByText('删除选中品类(0)') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('二级页：行「删除」作者 → confirm → deleteFileAuthor(品类, 作者) → 刷新', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileAuthor).mockResolvedValue({ ok: true, deleted: 1, filesRemoved: true })
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    const row = screen.getByText('作者A').closest('tr')!
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    expect(window.api.deleteFileAuthor).toHaveBeenCalledWith('美食', '作者A')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 1 条'))
    expect(window.api.getFilesTree).toHaveBeenCalled()
  })

  it('二级页：批量「删除选中作者(N)」', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    // 勾选锚点行 A，再 shift 点行 B → 范围选中两个
    const cbA = screen.getByText('作者A').closest('tr')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(cbA)
    const rowB = screen.getByText('作者B').closest('tr')!
    fireEvent.click(rowB, { shiftKey: true })
    const btn = screen.getByText('删除选中作者(2)')
    fireEvent.click(btn)
    // 前端循环逐条调单删（异步），等两个调用都落地
    await waitFor(() => {
      expect(window.api.deleteFileAuthor).toHaveBeenCalledWith('美食', '作者A')
      expect(window.api.deleteFileAuthor).toHaveBeenCalledWith('美食', '作者B')
    })
  })

  it('删除失败（ok:false deleted:0）→ 提示错误', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileCategory).mockResolvedValue({ ok: false, deleted: 0, error: '磁盘错误' })
    const row = screen.getByText('美食').closest('tr')!
    const delBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')
    fireEvent.click(delBtn!)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('删除失败：磁盘错误'))
  })

  it('一级页顶部显示总大小（GB/MB 自适应：3.5MB → "3.5 MB"）', async () => {
    await setup()
    expect(screen.getByText('总大小：3.5 MB')).toBeTruthy()
  })

  it('二级页顶部显示「该品类共 X」', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    expect(screen.getByText('该品类共 3.0 MB')).toBeTruthy()
  })

  it('行「定位」品类：调 locateFileDir(下载目录/品类) → notify 成功反馈', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: true })
    const row = screen.getByText('美食').closest('tr')!
    const locBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '定位')
    fireEvent.click(locBtn!)
    expect(window.api.locateFileDir).toHaveBeenCalledWith('D:/下载/美食')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已在资源管理器中定位 品类「美食」'))
  })

  it('行「定位」品类失败（ok:false）→ notify 错误', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: false, error: '目录不存在' })
    const row = screen.getByText('旅行').closest('tr')!
    const locBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '定位')
    fireEvent.click(locBtn!)
    await waitFor(() => expect(notify).toHaveBeenCalledWith('定位失败：目录不存在'))
  })

  it('二级页：行「定位」作者：调 locateFileDir(下载目录/品类/作者)', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    const row = screen.getByText('作者A').closest('tr')!
    const locBtn = Array.from(row.querySelectorAll('button')).find(b => b.textContent === '定位')
    fireEvent.click(locBtn!)
    expect(window.api.locateFileDir).toHaveBeenCalledWith('D:/下载/美食/作者A')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已在资源管理器中定位 作者「作者A」'))
  })
})
