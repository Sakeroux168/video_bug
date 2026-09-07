import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import { installFakeApi } from '../helpers/fake-api'

// 筛选条件表单测试（需求 2026-08-02i ②）：目标数量 1-1000 自由设置

function setup(onSubmit = vi.fn(async () => ({ id: 1, skipped: false }))): ReturnType<typeof vi.fn> {
  installFakeApi()
  render(<FilterForm onSubmit={onSubmit} />)
  return onSubmit
}

describe('目标数量 1-1000 自由设置', () => {
  it('默认 200：校验通过，可提交', () => {
    setup()
    expect(screen.getByText('开始抓取')).toBeEnabled()
    expect(screen.queryByText(/需在 1-1000/)).not.toBeInTheDocument()
  })

  it('填 50 / 300 / 1000 都能提交，目标数量传给 createTask', async () => {
    const onSubmit = setup()
    for (const n of [50, 300, 1000]) {
      fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '美食' } })
      fireEvent.change(screen.getByLabelText(/目标数量/), { target: { value: String(n) } })
      fireEvent.click(screen.getByText('开始抓取'))
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        filters: expect.objectContaining({ targetCount: n })
      })))
    }
  })

  it('越界（0 / 1001 / -5）报错「需在 1-1000」且不可提交；空输入同样拦截', () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '美食' } })
    for (const bad of ['0', '1001', '-5', '']) {
      fireEvent.change(screen.getByLabelText(/目标数量/), { target: { value: bad } })
      expect(screen.getByText('需在 1-1000')).toBeInTheDocument()
      expect(screen.getByText('开始抓取')).toBeDisabled()
    }
  })
})

describe('视频时长筛选', () => {
  it('提供30秒内选项并按 under30 提交', async () => {
    const onSubmit = setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '美食' } })
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: 'under30' } })
    fireEvent.click(screen.getByText('开始抓取'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ duration: 'under30' })
    })))
  })

  it('自定义10-20秒显示两个输入框并提交包含边界', async () => {
    const onSubmit = setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '美食' } })
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('最短秒数'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('最长秒数'), { target: { value: '20' } })
    fireEvent.click(screen.getByText('开始抓取'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ duration: 'custom', durationMinSec: 10, durationMaxSec: 20 })
    })))
  })

  it.each([
    ['', '20'],
    ['10', ''],
    ['20', '10'],
    ['0', '20'],
    ['10.5', '20']
  ])('自定义范围 %s-%s 无效时提示并禁止抓取', (min, max) => {
    setup()
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('最短秒数'), { target: { value: min } })
    fireEvent.change(screen.getByLabelText('最长秒数'), { target: { value: max } })

    expect(screen.getByText('自定义时长需为正整数，且最长秒数不能小于最短秒数')).toBeInTheDocument()
    expect(screen.getByText('开始抓取')).toBeDisabled()
  })
})

// D 阶段：界面文案跟随平台。作者输入框以前永远提示抖音主页链接，
// 选了快手仍然写着 douyin.com，用户照着填必然失败。
describe('作者输入提示跟随所选平台', () => {
  const platforms = [
    { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'https://www.douyin.com/user/xxx' },
    { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'https://www.kuaishou.com/profile/xxx' }
  ]

  async function renderWithPlatforms() {
    installFakeApi()
    vi.mocked(window.api.listPlatforms).mockResolvedValue(platforms as never)
    render(<FilterForm onSubmit={vi.fn(async () => ({ id: 1, skipped: false }))} />)
    await screen.findByRole('option', { name: '快手' })
  }

  it('默认抖音：作者输入框提示抖音主页链接', async () => {
    await renderWithPlatforms()
    fireEvent.click(screen.getByLabelText('作者'))
    expect(await screen.findByPlaceholderText('https://www.douyin.com/user/xxx')).toBeInTheDocument()
  })

  it('切到快手：提示换成快手主页链接，不再显示 douyin.com', async () => {
    await renderWithPlatforms()
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'kuaishou' } })
    fireEvent.click(screen.getByLabelText('作者'))

    expect(await screen.findByPlaceholderText('https://www.kuaishou.com/profile/xxx')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('https://www.douyin.com/user/xxx')).not.toBeInTheDocument()
  })

  it('关键词/话题类型仍用通用提示，不显示任何平台 URL', async () => {
    await renderWithPlatforms()
    expect(await screen.findByPlaceholderText('输入内容')).toBeInTheDocument()
  })
})
