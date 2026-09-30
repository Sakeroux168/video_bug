import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByText(/该平台的手机端扫码登录/)).toBeInTheDocument()
    expect(screen.getByText(/滑块.*扫码/)).toBeInTheDocument()

    const showButton = screen.getByRole('button', { name: /重新显示窗口/ })
    expect(showButton).toHaveAttribute('data-action', 'show-browser')
  })

  it('保留手动找回窗口和打开调试控制台的操作', () => {
    render(<BrowserPanel />)

    fireEvent.click(screen.getByRole('button', { name: /重新显示窗口/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开调试控制台' }))

    expect(window.api.showBrowser).toHaveBeenCalledTimes(1)
    expect(window.api.openBrowserDevtools).toHaveBeenCalledTimes(1)
  })

  it('把首次登录呈现为三步，并将验证和窗口找回放在独立指引中', () => {
    const { container } = render(<BrowserPanel />)

    expect(container.querySelectorAll('[data-login-step]')).toHaveLength(3)
    expect(screen.getByText('打开该平台窗口')).toBeInTheDocument()
    expect(screen.getByText('扫码登录')).toBeInTheDocument()
    expect(screen.getByText('确认登录状态')).toBeInTheDocument()
    expect(screen.getByText(/首页未登录也能打开/)).toBeInTheDocument()
    expect(screen.queryByText(/看到该平台首页即表示成功/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '遇到验证' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '找不到窗口' })).toBeInTheDocument()
  })
})

// 员工反馈：这里只能打开抖音窗口，打不开快手的。
// 各平台登录状态互相独立，而扫码登录只能在对应平台的窗口里做——
// 没有入口就等于没法登录快手。
describe('BrowserPanel 按平台打开窗口', () => {
  const PLATFORMS = [
    { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true },
    { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'y', taskReady: true }
  ]

  beforeEach(() => {
    installFakeApi()
    vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  })

  it('每个已注册平台各给一个入口（以后加小红书会自动出现）', async () => {
    render(<BrowserPanel />)
    expect(await screen.findByRole('button', { name: '打开抖音窗口' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开快手窗口' })).toBeInTheDocument()
  })

  it('点「打开快手窗口」→ 按平台名调主进程', async () => {
    render(<BrowserPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '打开快手窗口' }))
    expect(window.api.openBrowserFor).toHaveBeenCalledWith('kuaishou')
  })

  it('被拒绝时把原因显示出来（任务运行中切平台会打断任务）', async () => {
    const notify = vi.fn()
    vi.mocked(window.api.openBrowserFor).mockResolvedValue({ ok: false, error: '有任务正在运行，切换平台会打断它，请先暂停任务' })
    render(<BrowserPanel notify={notify} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开快手窗口' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/有任务正在运行/)))
  })
})
