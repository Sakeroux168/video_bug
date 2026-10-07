import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-07 功能 N02：只抓热门——新建抓取表单里可以设「最少点赞」「最少收藏」

const platforms = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: '', taskReady: true, interactions: ['collects', 'shares'], sortOptions: ['mostLiked', 'latest'] },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: '', taskReady: true, interactions: ['plays'] }
]
async function setup() {
  installFakeApi()
  vi.mocked(window.api.listPlatforms).mockResolvedValue(platforms as never)
  const onSubmit = vi.fn(async () => ({ id: 1, skipped: false }))
  render(<FilterForm onSubmit={onSubmit} />)
  await screen.findByRole('option', { name: '快手' })
  return onSubmit
}

describe('N02 最少点赞 / 最少收藏', () => {
  it('填了就随任务提交；不填就没有门槛', async () => {
    const onSubmit = await setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.change(screen.getByLabelText('最少点赞'), { target: { value: '1000' } })
    fireEvent.change(screen.getByLabelText('最少收藏'), { target: { value: '50' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ minLikes: 1000, minCollects: 50 })
    })))
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '狗狗' } })
    fireEvent.change(screen.getByLabelText('最少点赞'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('最少收藏'), { target: { value: '' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    const f = (onSubmit.mock.calls[1] as unknown as [{ filters: Record<string, unknown> }])[0].filters
    expect(f.minLikes).toBeUndefined()
    expect(f.minCollects).toBeUndefined()
  })

  it('快手拿不到收藏数：不显示「最少收藏」，也不提交它', async () => {
    const onSubmit = await setup()
    fireEvent.change(screen.getByLabelText('最少收藏'), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'kuaishou' } })
    expect(screen.queryByLabelText('最少收藏')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect((onSubmit.mock.calls[0] as unknown as [{ filters: Record<string, unknown> }])[0].filters.minCollects).toBeUndefined()
  })

  it('门槛只能填 0 以上的整数', async () => {
    await setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.change(screen.getByLabelText('最少点赞'), { target: { value: '-5' } })
    fireEvent.click(screen.getByText('开始抓取'))
    expect(await screen.findByText('门槛要填 0 以上的整数')).toBeInTheDocument()
  })
})

// 2026-10-07 功能 N01：按最多点赞 / 最新排序抓
describe('N01 排序', () => {
  it('抖音：「排序」只列这个平台网页上真有的选项；选了随任务提交', async () => {
    const onSubmit = await setup()
    const select = screen.getByLabelText('排序') as HTMLSelectElement
    expect([...select.options].map(o => o.textContent)).toEqual(['综合（默认）', '最多点赞', '最新'])
    fireEvent.change(select, { target: { value: 'mostLiked' } })
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByText('开始抓取'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ sortBy: 'mostLiked' })
    })))
  })

  it('快手网页搜索没有排序：不显示「排序」；抓作者主页时也不显示', async () => {
    await setup()
    fireEvent.click(screen.getByLabelText('作者'))
    expect(screen.queryByLabelText('排序')).toBeNull()
    fireEvent.click(screen.getByLabelText('关键词'))
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'kuaishou' } })
    expect(screen.queryByLabelText('排序')).toBeNull()
  })
})
