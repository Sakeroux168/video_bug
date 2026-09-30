import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installFakeApi } from '../helpers/fake-api'
import Overview from '../../src/renderer/src/components/Overview'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow } from '../../src/shared/types'

beforeEach(() => {
  installFakeApi()
  Object.assign(window.api, { getLoginStatuses: vi.fn(async () => [
    { platform: 'douyin', displayName: '抖音', status: 'logged_in' },
    { platform: 'kuaishou', displayName: '快手', status: 'logged_out' },
    { platform: 'xiaohongshu', displayName: '小红书', status: 'unknown' }
  ]) })
  vi.mocked(window.api.listPlatforms).mockResolvedValue([
    { name: 'douyin', displayName: '抖音', taskReady: true, authorInputPlaceholder: '' },
    { name: 'kuaishou', displayName: '快手', taskReady: true, authorInputPlaceholder: '' }
  ])
})

describe('登录状态与暂停原因', () => {
  it('状态未知允许建任务，重新查询已登录后不再出现未登录提示', async () => {
    const submit = vi.fn(async () => ({ id: 1, skipped: false }))
    vi.mocked(window.api.getLoginStatuses).mockResolvedValue([{ platform: 'douyin', displayName: '抖音', status: 'unknown' }])
    render(<FilterForm onSubmit={submit} />)
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/还没登录，登录后再开始抓取/)).not.toBeInTheDocument()
  })

  it('用户刚登录后，提交时现查的新状态优先于状态灯旧值', async () => {
    const submit = vi.fn(async () => ({ id: 1, skipped: false }))
    render(<FilterForm onSubmit={submit} />)
    await screen.findByRole('option', { name: '快手' })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'kuaishou' } })
    await screen.findByText('快手：未登录')
    vi.mocked(window.api.getLoginStatuses).mockResolvedValue([{ platform: 'kuaishou', displayName: '快手', status: 'logged_in' }])
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('概览展示三种状态', async () => {
    render(<Overview onGoto={() => {}} />)
    expect(await screen.findByText('抖音：已登录')).toBeInTheDocument()
    expect(screen.getByText('快手：未登录')).toBeInTheDocument()
    expect(screen.getByText('小红书：未知')).toBeInTheDocument()
  })

  it('未登录先提示，可去登录，也可明确选择仍然继续', async () => {
    const submit = vi.fn(async () => ({ id: 1, skipped: false }))
    render(<FilterForm onSubmit={submit} />)
    await screen.findByRole('option', { name: '快手' })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'kuaishou' } })
    expect(await screen.findByText('快手：未登录')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByText('开始抓取'))
    expect(await screen.findByText('快手还没登录，登录后再开始抓取。')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('去登录'))
    expect(window.api.openBrowserFor).toHaveBeenCalledWith('kuaishou')
    fireEvent.click(screen.getByText('仍然继续'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it.each(['login_required', 'stalled_verify'])('暂停原因 %s 在主任务行显示，不需要展开', async error => {
    vi.mocked(window.api.listTasks).mockResolvedValue([{
      id: 1, platform: 'kuaishou', type: 'keyword', query: '猫咪', status: 'paused', error,
      filters: '{}', target_count: 1, fetched_count: 0, auto_download: 0,
      created_at: '', finished_at: null
    } as TaskRow])
    render(<TaskList notify={() => {}} />)
    const text = await screen.findByText(error === 'login_required' ? /快手没登录/ : /快手需要验证/)
    expect(text.closest('tr')).toHaveTextContent('展开')
    fireEvent.click(screen.getByText('打开快手窗口'))
    expect(window.api.openBrowserFor).toHaveBeenCalledWith('kuaishou')
    expect(window.api.listTaskVideos).not.toHaveBeenCalled()
  })
})
