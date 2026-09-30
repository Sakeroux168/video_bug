import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import { installFakeApi } from '../helpers/fake-api'

// 小红书建任务可选详情取数模式（稳妥/快速），默认稳妥，仅小红书显示

const XHS_READY = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true },
  { name: 'xiaohongshu', displayName: '小红书', authorInputPlaceholder: 'y', taskReady: true,
    supportedTaskTypes: ['keyword', 'author', 'hashtag'] }
] as never

function setupPlatform(onSubmit = vi.fn(async () => ({ id: 1, skipped: false }))): ReturnType<typeof vi.fn> {
  installFakeApi()
  vi.mocked(window.api.listPlatforms).mockResolvedValue(XHS_READY)
  render(<FilterForm onSubmit={onSubmit} />)
  return onSubmit
}

describe('FilterForm 详情取数模式（仅小红书）', () => {
  it('小红书显示稳妥/快速单选，默认稳妥，并说明快速模式更像程序访问', async () => {
    setupPlatform()
    await screen.findByRole('option', { name: '小红书' })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'xiaohongshu' } })
    expect(screen.getByLabelText('稳妥')).toBeChecked()
    expect(screen.getByLabelText('快速')).not.toBeChecked()
    expect(screen.getByText(/更像程序访问/)).toBeInTheDocument()
  })

  it('选快速并提交 → filters.detailMode=fast', async () => {
    const onSubmit = setupPlatform()
    await screen.findByRole('option', { name: '小红书' })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'xiaohongshu' } })
    fireEvent.click(screen.getByLabelText('快速'))
    fireEvent.change(screen.getByLabelText('关键词', { selector: 'input:not([type])' }), { target: { value: '美食' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'xiaohongshu',
      filters: expect.objectContaining({ detailMode: 'fast' })
    })))
  })

  it('默认稳妥提交 → filters.detailMode=safe', async () => {
    const onSubmit = setupPlatform()
    await screen.findByRole('option', { name: '小红书' })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'xiaohongshu' } })
    fireEvent.change(screen.getByLabelText('关键词', { selector: 'input:not([type])' }), { target: { value: '美食' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ detailMode: 'safe' })
    })))
  })

  it('非小红书平台不显示模式单选，filters 不带 detailMode', async () => {
    const onSubmit = setupPlatform()
    await screen.findByRole('option', { name: '抖音' })
    expect(screen.queryByLabelText('稳妥')).toBeNull()
    expect(screen.queryByLabelText('快速')).toBeNull()
    fireEvent.change(screen.getByLabelText('关键词', { selector: 'input:not([type])' }), { target: { value: '搞笑' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const arg = onSubmit.mock.calls[0][0] as { filters: Record<string, unknown> }
    expect(arg.filters.detailMode).toBeUndefined()
  })
})
