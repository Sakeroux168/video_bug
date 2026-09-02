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
