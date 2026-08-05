import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import { installFakeApi } from '../helpers/fake-api'

// 筛选条件表单测试（需求 2026-08-02i ②③）：目标数量 1-1000 自由设置 + 测试筛选按钮移入筛选续爬配置区

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

describe('测试筛选按钮（移入筛选续爬配置区）', () => {
  it('默认隐藏，开启「搜索到底后用抖音筛选续爬」后出现', () => {
    setup()
    expect(screen.queryByText('测试筛选')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('搜索到底后用抖音筛选续爬'))
    expect(screen.getByText('测试筛选')).toBeInTheDocument()
  })

  it('点击调用 api.testFilter(true)（静默版，不写拦截日志）并就地显示结果文案', async () => {
    setup()
    fireEvent.click(screen.getByLabelText('搜索到底后用抖音筛选续爬'))
    fireEvent.click(screen.getByText('测试筛选'))
    expect(window.api.testFilter).toHaveBeenCalledTimes(1)
    expect(window.api.testFilter).toHaveBeenCalledWith(true)
    expect(await screen.findByText('筛选执行成功')).toBeInTheDocument()
  })

  it('执行中防重：按钮置灰变「筛选中...」，busy 期间再点不重复调用', async () => {
    setup()
    let resolveFn: (v: { ok: boolean; message: string }) => void = () => {}
    vi.mocked(window.api.testFilter).mockImplementationOnce(() => new Promise(res => { resolveFn = res }))
    fireEvent.click(screen.getByLabelText('搜索到底后用抖音筛选续爬'))
    fireEvent.click(screen.getByText('测试筛选'))
    const busyBtn = screen.getByText('筛选中...')
    expect(busyBtn).toBeDisabled()
    fireEvent.click(busyBtn)
    expect(window.api.testFilter).toHaveBeenCalledTimes(1)
    expect(window.api.testFilter).toHaveBeenCalledWith(true)
    resolveFn({ ok: true, message: '筛选执行成功' })
    expect(await screen.findByText('筛选执行成功')).toBeInTheDocument()
  })
})
