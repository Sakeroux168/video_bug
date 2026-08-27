import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettingsPanel from '../../src/renderer/src/components/SettingsPanel'
import type { AppSettings } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// P3 里唯一允许的行为改动：成功与失败此前共用同一个绿色 span，
// 「AI 连接失败：xxx」会被渲染成绿色——用户一眼看过去以为成功了。
// 这里破例断言颜色类，因为**被测的就是颜色语义本身**；同时断言文案，
// 保证不是只测样式（否则把文案改没了测试也会绿）。

function msgEl(container: HTMLElement): HTMLElement | null {
  return Array.from(container.querySelectorAll('span'))
    .find(el => /连接正常|连接失败/.test(el.textContent ?? '')) ?? null
}

const SETTING_LABELS: Record<keyof AppSettings, string> = {
  downloadDir: '下载目录',
  aiBaseUrl: 'API 地址',
  aiApiKey: 'API Key',
  aiModel: '模型',
  downloadConcurrency: '下载并发',
  scrollIntervalMs: '滚动间隔(ms)',
  scrollSpeed: '滚动速度',
  scrollPageWaitMs: '每页最大等待(秒)',
  addressTtlMin: '地址过期(分钟)',
  allowDuplicateAuthor: '允许重复爬取已爬过主页的作者（取消勾选则自动去重跳过）',
  organizeDebounceMs: '自动归档延迟(秒)',
  asrMaxSec: '语音分析时长(秒)',
  stallThresholdSec: '停滞检测(秒)',
  rescueCooldownSec: '重搜冷却(秒)'
}

describe('SettingsPanel 消息的成功/失败配色', () => {
  it('AI 连接失败 → 用危险色，不能是成功色', async () => {
    installFakeApi()
    vi.mocked(window.api.testAi).mockResolvedValue({ ok: false, error: '密钥无效' } as never)
    const { container } = render(<SettingsPanel />)

    fireEvent.click(await screen.findByText('测试连接'))
    await waitFor(() => expect(msgEl(container)).not.toBeNull())

    const el = msgEl(container)!
    expect(el.textContent).toContain('失败')
    expect(el.className).toContain('danger')
    expect(el.className).not.toContain('success')
    expect(el.className).not.toContain('emerald')
  })

  it('AI 连接正常 → 用成功色', async () => {
    installFakeApi()
    vi.mocked(window.api.testAi).mockResolvedValue({ ok: true } as never)
    const { container } = render(<SettingsPanel />)

    fireEvent.click(await screen.findByText('测试连接'))
    await waitFor(() => expect(msgEl(container)).not.toBeNull())

    const el = msgEl(container)!
    expect(el.textContent).toContain('正常')
    expect(el.className).toContain('success')
    expect(el.className).not.toContain('danger')
  })
})

describe('SettingsPanel 分组与字段完整性', () => {
  it('用双栏展示 6 个职责清晰的设置分组，并让保存操作保持可见', async () => {
    installFakeApi()
    const { container } = render(<SettingsPanel />)
    await screen.findByRole('heading', { name: '存储位置' })

    expect(container.firstElementChild).toHaveClass('max-w-5xl')
    expect(container.querySelector('[data-settings-grid]')).toHaveClass('lg:grid-cols-2')
    for (const title of ['存储位置', '抓取参数', '下载与去重', 'AI 配置', '语音模型', '归档整理']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    expect(container.querySelector('[data-settings-actions]')).toHaveClass('sticky', 'bottom-0')
  })

  it('AppSettings 的每个字段都能在界面中编辑', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    for (const label of Object.values(SETTING_LABELS)) {
      const control = await screen.findByLabelText(label)
      expect(control).toBeEnabled()
      expect(control).not.toHaveAttribute('readonly')
    }
  })

  it('新增的归档延迟和语音时长会按正确单位保存', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    fireEvent.change(await screen.findByLabelText('自动归档延迟(秒)'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('语音分析时长(秒)'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      organizeDebounceMs: 8000,
      asrMaxSec: 120
    })))
  })

  it('语音分析时长被清空或小于 10 秒时拒绝保存', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    fireEvent.change(await screen.findByLabelText('语音分析时长(秒)'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(await screen.findByText('语音分析时长不能少于 10 秒')).toBeInTheDocument()
    expect(window.api.saveSettings).not.toHaveBeenCalled()
  })

  it('自动归档延迟小于 0 秒时拒绝保存', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    fireEvent.change(await screen.findByLabelText('自动归档延迟(秒)'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(await screen.findByText('自动归档延迟不能小于 0 秒')).toBeInTheDocument()
    expect(window.api.saveSettings).not.toHaveBeenCalled()
  })

  it('归档工具与语音模型分属不同卡片', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    const organizeCard = (await screen.findByRole('heading', { name: '归档整理' })).parentElement
    const asrCard = screen.getByRole('heading', { name: '语音模型' }).parentElement

    expect(organizeCard).toContainElement(screen.getByRole('button', { name: '整理全部' }))
    expect(asrCard).toContainElement(screen.getByRole('button', { name: '下载模型' }))
    expect(asrCard).not.toContainElement(screen.getByRole('button', { name: '整理全部' }))
  })
})
