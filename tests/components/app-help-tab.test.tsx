import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../../src/renderer/src/App'
import { installFakeApi } from '../helpers/fake-api'

// Task2（round15）：① Tabs 追加「使用说明」并渲染 HelpPanel；③ 任务页有一条低调引导，
// 点击后切到「使用说明」tab。任务页 FilterForm/TaskList 常驻挂载（hidden 而非卸载），不能改。

describe('App：使用说明 tab 与任务页引导条', () => {
  it('Tabs 里有「使用说明」，点击后渲染 HelpPanel 的内容', async () => {
    installFakeApi()
    const { container } = render(<App />)
    const tabBtn = screen.getByRole('button', { name: '使用说明' })
    fireEvent.click(tabBtn)
    await waitFor(() => expect(container.textContent ?? '').toContain('扫码登录'))
  })

  it('任务页有低调引导条，点击后切到使用说明 tab', async () => {
    installFakeApi()
    const { container } = render(<App />)
    // 默认在任务页；引导条文案含「不知道怎么用」，与顶部 Tabs 里的「使用说明」按钮本身不同，避免误匹配
    const hint = screen.getByText(/不知道怎么用/)
    fireEvent.click(hint)
    await waitFor(() => expect(container.textContent ?? '').toContain('扫码登录'))
  })
})
