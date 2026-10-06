import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import App from '../../src/renderer/src/App'
import type { TaskRow, AuthorRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-06 全面检查「界面」D1–D3：任务表排版、删除前确认、设置没保存就切页

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1, platform: 'douyin', type: 'keyword', query: '猫咪', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 3, auto_download: 1,
    error: null, created_at: '2026-10-01T00:00:00.000Z', finished_at: null, ...over
  } as TaskRow
}
const stats = (total: number): TaskStats => ({ total, done: total, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 })
function author(over: Partial<AuthorRow> = {}): AuthorRow {
  return {
    id: 7, platform: 'douyin', sec_uid: 'S1', nickname: '张三', home_url: 'https://www.douyin.com/user/S1',
    video_count: 5, last_fetched_at: null, note: null, category: null, organize_state: null,
    ai_classified_at: null, verify_state: null, verify_error: null, ...over
  } as AuthorRow
}

afterEach(() => { vi.restoreAllMocks() })

describe('D1 任务表：状态列只放短标签，原因放到下面整行', () => {
  it('表格用固定列宽（内容变了不跳）', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task()])
    const { container } = render(<TaskList notify={() => {}} />)
    await screen.findByText('"猫咪"')
    expect(container.querySelector('table')?.className).toMatch(/table-fixed/)
    expect(container.querySelectorAll('table > colgroup > col').length).toBe(6)
  })

  it.each([
    ['login_required', '没登录', /没登录 → .*登好后点「继续」/],
    ['stalled_verify', '需要验证', /需要验证 → .*完成验证后点「继续」/],
    ['stalled', '没有新结果', /没有新结果，已暂停/],
    ['stuck', '卡住了', /卡住了，已跳过（可点「继续」重试）/],
    ['risk', '疑似风控', /疑似风控，已暂停/]
  ])('暂停原因 %s：状态列显示「%s」，完整说明在下面一行', async (error, badge, reason) => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task({ status: 'paused', error })])
    render(<TaskList notify={() => {}} />)
    const status = await screen.findByTestId('task-status-1')
    expect(status.textContent).toBe(badge)
    // 说明可能拆成几段（中间夹着「打开窗口」按钮），按整行文字找
    const row = Array.from(document.querySelectorAll('tbody tr')).find(tr => reason.test(tr.textContent ?? ''))
    expect(row).toBeTruthy()
    expect(row!.querySelectorAll('td').length).toBe(1)
    expect(row!.querySelector('td')?.getAttribute('colspan')).toBe('6')
  })
})

describe('D2 删除任务、删除作者要先确认', () => {
  it('删任务：确认框写明会删掉几条视频记录、文件留着；点取消就不删', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task()])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(stats(3))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TaskList notify={() => {}} />)
    await screen.findByText('完成 3')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(confirm).toHaveBeenCalledWith('确定删除任务「猫咪」？会删掉它的 3 条视频记录，已下载的文件留在磁盘上。')
    expect(window.api.deleteTask).not.toHaveBeenCalled()
  })

  it('删正在跑的任务：确认框多一句「会先停下来」；点确定才删，删完有提示', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task({ status: 'running' })])
    vi.mocked(window.api.getTaskStats).mockResolvedValue(stats(0))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const notify = vi.fn()
    render(<TaskList notify={notify} />)
    await screen.findByText('"猫咪"')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(confirm.mock.calls[0][0]).toMatch(/这个任务正在跑，会先停下来/)
    await waitFor(() => expect(window.api.deleteTask).toHaveBeenCalledWith(1))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除任务「猫咪」'))
  })

  it('删作者（行内）：确认框写明后果；点取消就不删', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([author()])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    const row = Array.from(container.querySelectorAll('tbody tr')).find(r => (r.textContent ?? '').includes('张三'))!
    fireEvent.click(Array.from(row.querySelectorAll('button')).find(b => b.textContent === '删除')!)
    expect(confirm.mock.calls[0][0]).toBe('确定删除作者「张三」？会删掉这个作者的 5 条视频记录和追更记录，已下载的文件留在磁盘上。')
    expect(window.api.deleteAuthors).not.toHaveBeenCalled()
  })

  it('删选中的作者：确认框写明人数；点确定才删', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([author(), author({ id: 8, sec_uid: 'S2', nickname: '李四', video_count: 2 })])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    for (const cb of screen.getAllByRole('checkbox').filter(c => c.closest('tbody'))) fireEvent.click(cb)
    fireEvent.click(screen.getByRole('button', { name: /删除选中/ }))
    expect(confirm.mock.calls[0][0]).toBe('确定删除选中的 2 个作者？会删掉这些作者的 7 条视频记录和追更记录，已下载的文件留在磁盘上。')
    await waitFor(() => expect(window.api.deleteAuthors).toHaveBeenCalled())
  })
})

describe('D3 设置改了没保存就切页 → 先问一声', () => {
  async function openSettingsAndEdit() {
    installFakeApi()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const input = await screen.findByLabelText('下载并发')
    fireEvent.change(input, { target: { value: '2' } })
    return input
  }

  it('改了没保存：保存按钮带圆点；切到别的页先确认，点取消就留在设置页', async () => {
    await openSettingsAndEdit()
    expect(screen.getByTestId('settings-dirty')).toBeInTheDocument() // 保存按钮带圆点
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: '概览' }))
    expect(confirm).toHaveBeenCalledWith('设置改了还没保存，要放弃这些修改吗？')
    expect(screen.getByLabelText('下载并发')).toHaveValue(2)
  })

  it('点确定放弃 → 切过去', async () => {
    await openSettingsAndEdit()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '概览' }))
    await waitFor(() => expect(screen.queryByLabelText('下载并发')).toBeNull())
  })

  it('保存过了再切页 → 不问', async () => {
    await openSettingsAndEdit()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByTestId('settings-dirty')).toBeNull())
    const confirm = vi.spyOn(window, 'confirm')
    fireEvent.click(screen.getByRole('button', { name: '概览' }))
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByLabelText('下载并发')).toBeNull())
  })
})
