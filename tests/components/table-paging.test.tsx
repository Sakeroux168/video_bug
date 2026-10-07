import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import type { AuthorRow, TaskRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-07 性能 F14：任务表、作者表以前全部一次画出来；几百个任务、几千个作者时每次刷新都整表重画。
// 现在每页 100 条，下面有「上一页 / 下一页」。

function task(id: number): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: `任务${id}`, filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-10-01T00:00:00.000Z', finished_at: null
  }
}
function author(id: number): AuthorRow {
  return {
    id, platform: 'douyin', sec_uid: `S${id}`, nickname: `作者${id}`, home_url: null, video_count: 1,
    last_fetched_at: null, note: null, category: null, organize_state: null, ai_classified_at: null,
    verify_state: null, verify_error: null, latest_video_at: null, last_crawled_at: null
  }
}

describe('任务表分页', () => {
  it('150 个任务：先显示 100 个，翻到下一页看到剩下的；全选只选这一页', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue(Array.from({ length: 150 }, (_, i) => task(i + 1)))
    render(<TaskList notify={() => {}} />)
    const row = (id: number) => screen.queryByRole('checkbox', { name: `选择任务 ${id}` })
    expect(await screen.findByRole('checkbox', { name: '选择任务 1' })).toBeInTheDocument()
    expect(row(101)).toBeNull()
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '全选任务' }))
    expect(screen.getByRole('button', { name: '合并导出选中任务(100)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页任务' }))
    expect(await screen.findByRole('checkbox', { name: '选择任务 101' })).toBeInTheDocument()
    expect(row(1)).toBeNull()
  })

  it('不到 100 个任务：不显示翻页', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task(1), task(2)])
    render(<TaskList notify={() => {}} />)
    await screen.findByRole('checkbox', { name: '选择任务 1' })
    expect(screen.queryByRole('button', { name: '下一页任务' })).toBeNull()
  })
})

describe('作者表分页', () => {
  it('250 个作者：一页 100 个，可以翻页；全选只选这一页', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue(Array.from({ length: 250 }, (_, i) => author(i + 1)))
    render(<AuthorCollection notify={() => {}} />)
    expect(await screen.findByText('作者1')).toBeInTheDocument()
    expect(screen.queryByText('作者101')).toBeNull()
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页作者' }))
    await waitFor(() => expect(screen.getByText('作者101')).toBeInTheDocument())
    expect(screen.queryByText('作者1')).toBeNull()
    fireEvent.click(document.querySelector('thead input[type="checkbox"]')!)
    expect(screen.getByRole('button', { name: /删除选中（100）/ })).toBeInTheDocument()
  })
})

// 2026-10-07 性能 F3：文件管理切走再回来，先显示上次的结果，后台再扫一遍
describe('文件管理回来先显示上次的结果', () => {
  it('第二次进来：没等扫描完就能看到上次的文件夹，并提示正在刷新', async () => {
    const { default: FileManager } = await import('../../src/renderer/src/components/FileManager')
    installFakeApi()
    vi.mocked(window.api.getFilesTree).mockResolvedValue({
      root: { name: '', videoCount: 1, size: 1, files: [], dirs: [{ name: '美食', videoCount: 1, size: 1, dirs: [], files: [{ name: 'a.mp4', size: 1 }] }] },
      totalSize: 1, downloadDir: 'D:/下载'
    })
    const first = render(<FileManager notify={() => {}} />)
    await screen.findByText('美食')
    first.unmount()
    vi.mocked(window.api.getFilesTree).mockImplementation(() => new Promise(() => {}))
    render(<FileManager notify={() => {}} />)
    expect(screen.getByText('美食')).toBeInTheDocument()
    expect(screen.getByTestId('files-refreshing')).toBeInTheDocument()
  })
})
