import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from '../../src/renderer/src/App'
import { installFakeApi } from '../helpers/fake-api'

// App 头部「手动测试筛选」诊断按钮测试（需求 2026-08-02i ③ 纠正版）：
// 头部按钮保留（带日志版），筛选模块内另加 silent 静默版；此处验证头部按钮行为/防重不变

describe('App 头部「手动测试筛选」诊断按钮', () => {
  it('点击调 api.testFilter()（不带 silent → 日志进拦截日志面板），结果 toast + 刷新日志', async () => {
    installFakeApi()
    render(<App />)
    fireEvent.click(screen.getByText('手动测试筛选'))
    expect(window.api.testFilter).toHaveBeenCalledTimes(1)
    expect(window.api.testFilter).toHaveBeenCalledWith()
    expect(await screen.findByText('筛选执行成功')).toBeInTheDocument()
    // 诊断版：执行后刷新 rawLog（日志进「查看拦截日志」面板）
    expect(window.api.getRawLog).toHaveBeenCalledTimes(1)
  })

  it('执行中防重：按钮置灰变「筛选中...」，busy 期间再点不重复调用', async () => {
    installFakeApi()
    let resolveFn: (v: { ok: boolean; message: string }) => void = () => {}
    vi.mocked(window.api.testFilter).mockImplementationOnce(() => new Promise(res => { resolveFn = res }))
    render(<App />)
    fireEvent.click(screen.getByText('手动测试筛选'))
    const busyBtn = screen.getByText('筛选中...')
    expect(busyBtn).toBeDisabled()
    fireEvent.click(busyBtn)
    expect(window.api.testFilter).toHaveBeenCalledTimes(1)
    resolveFn({ ok: true, message: '筛选执行成功' })
    expect(await screen.findByText('筛选执行成功')).toBeInTheDocument()
  })
})
