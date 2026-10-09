import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-09：删任务不再让软件「忘了」视频（不重复下）；想重复下的，建任务时勾「以前下过的也重新下」；
// 任务堆得多，可以勾几个一起删。

const PLATFORMS = [{ name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true }] as never

describe('建任务：以前下过的也重新下', () => {
  async function submit(check: boolean): Promise<ReturnType<typeof vi.fn>> {
    installFakeApi()
    vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS)
    const onSubmit = vi.fn(async () => ({ id: 1, skipped: false }))
    render(<FilterForm onSubmit={onSubmit} />)
    const box = await screen.findByLabelText('以前下过的也重新下')
    expect(box).not.toBeChecked()
    if (check) fireEvent.click(box)
    fireEvent.change(screen.getByLabelText('关键词', { selector: 'input:not([type])' }), { target: { value: '猫' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit
  }

  it('默认不勾：不带这个选项', async () => {
    const onSubmit = await submit(false)
    expect(onSubmit.mock.calls[0][0].filters.redownload).toBeUndefined()
  })

  it('勾上：filters.redownload = true', async () => {
    const onSubmit = await submit(true)
    expect(onSubmit.mock.calls[0][0].filters.redownload).toBe(true)
  })
})

function task(id: number): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: `任务${id}`, filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-10-01T00:00:00.000Z', finished_at: null
  }
}

describe('任务列表：勾几个一起删', () => {
  it('勾 2 个 →「删除选中任务(2)」→ 确认后两个都删；确认框说清楚不会重复下载', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task(1), task(2), task(3)])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TaskList notify={() => {}} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择任务 1' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择任务 2' }))
    fireEvent.click(screen.getByRole('button', { name: '删除选中任务(2)' }))
    expect(confirm.mock.calls[0][0]).toMatch(/不会重复下载/)
    await waitFor(() => expect(window.api.deleteTask).toHaveBeenCalledTimes(2))
    expect(vi.mocked(window.api.deleteTask).mock.calls.map(c => c[0])).toEqual([1, 2])
  })

  it('确认框点取消 → 一个都不删', async () => {
    installFakeApi()
    vi.mocked(window.api.listTasks).mockResolvedValue([task(1)])
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TaskList notify={() => {}} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择任务 1' }))
    fireEvent.click(screen.getByRole('button', { name: '删除选中任务(1)' }))
    expect(window.api.deleteTask).not.toHaveBeenCalled()
  })
})
