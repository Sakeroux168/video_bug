import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../../src/renderer/src/App'
import { installFakeApi } from '../helpers/fake-api'

// 左侧导航顺序是产品约定：概览 / 任务 / 作者收藏 / 文件管理 / 视频处理 / 内置浏览器 / 设置 / 使用说明。
// 「视频处理」是把原来藏在设置里的统一分辨率能力拆出来的独立页，必须紧跟文件管理。

describe('App：左侧导航顺序与「视频处理」页', () => {
  it('导航顺序固定，「视频处理」位于文件管理与内置浏览器之间', () => {
    installFakeApi()
    const { container } = render(<App />)
    const labels = Array.from(container.querySelectorAll('nav button')).map(b => b.getAttribute('aria-label'))
    // 需求变更（2026-10-07）：新增「素材库」，放在文件管理和视频处理之间
    expect(labels).toEqual(['概览', '任务', '作者收藏', '文件管理', '素材库', '视频处理', '内置浏览器', '设置', '使用说明'])
  })

  it('点「视频处理」渲染处理页（标题与开始按钮），并拉取一次当前处理状态', async () => {
    installFakeApi()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '视频处理' }))
    await waitFor(() => expect(window.api.getProcessState).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: '开始处理' })).toBeTruthy()
    expect(screen.getByText(/统一分辨率/)).toBeTruthy()
  })
})
