import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import BrowserPanel from '../../src/renderer/src/components/BrowserPanel'
import { installFakeApi } from '../helpers/fake-api'

describe('BrowserPanel 使用指引', () => {
  beforeEach(() => { installFakeApi() })

  it('从内容顶部开始排版，并完整说明自动显隐、首次登录和风控验证', () => {
    const { container } = render(<BrowserPanel />)
    const root = container.firstElementChild

    expect(root).not.toHaveClass('h-full')
    expect(root).not.toHaveClass('justify-center')
    expect(screen.getByText(/切换到此页面时.*自动显示/)).toBeInTheDocument()
    expect(screen.getByText(/任务运行中.*自动显示/)).toBeInTheDocument()
    expect(screen.getByText(/首次使用.*扫码登录/)).toBeInTheDocument()
    expect(screen.getByText(/滑块.*扫码/)).toBeInTheDocument()

    const showButton = screen.getByRole('button', { name: /显示抖音窗口/ })
    expect(showButton).toHaveAttribute('data-action', 'show-browser')
  })

  it('保留手动找回窗口和打开调试控制台的操作', () => {
    render(<BrowserPanel />)

    fireEvent.click(screen.getByRole('button', { name: /显示抖音窗口/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开调试控制台' }))

    expect(window.api.showBrowser).toHaveBeenCalledTimes(1)
    expect(window.api.openBrowserDevtools).toHaveBeenCalledTimes(1)
  })

  it('把首次登录呈现为三步，并将验证和窗口找回放在独立指引中', () => {
    const { container } = render(<BrowserPanel />)

    expect(container.querySelectorAll('[data-login-step]')).toHaveLength(3)
    expect(screen.getByText('显示抖音窗口')).toBeInTheDocument()
    expect(screen.getByText('扫码登录')).toBeInTheDocument()
    expect(screen.getByText('确认进入首页')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '遇到验证' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '找不到窗口' })).toBeInTheDocument()
  })
})
