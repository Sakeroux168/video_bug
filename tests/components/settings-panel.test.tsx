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
  rescueCooldownSec: '重搜冷却(秒)',
  organizeByCategory: '按品类分文件夹',
  organizeByAuthor: '按作者分文件夹',
  organizeByOrientation: '按横屏/竖屏分文件夹',
  organizeByDuration: '按时长分文件夹',
  bridgeEnabled: '开本机接口，让发布助手能让本程序去抓某个作者的主页（只在这台电脑内部，不对外）',
  bridgePort: '端口'
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

  // 统一分辨率已从下载行为里撤出（改为「视频处理」页手动批处理），设置页不能再出现这两个开关，
  // 否则员工勾了会以为下载会转码。这里同时钉住替代说明文字，免得只删开关不留线索。
  it('「下载与去重」里不再有统一输出分辨率 / 保留原视频开关，并说明去视频处理页', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    const card = (await screen.findByRole('heading', { name: '下载与去重' })).parentElement!

    expect(screen.queryByLabelText('统一输出分辨率（推荐）')).toBeNull()
    expect(screen.queryByLabelText('保留原视频')).toBeNull()
    expect(card.textContent).toContain('视频处理')
    expect(card.textContent).toContain('不再自动转码')

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalled())
    const saved = vi.mocked(window.api.saveSettings).mock.calls[0][0] as unknown as Record<string, unknown>
    expect('normalizeVideo' in saved).toBe(false)
    expect('keepOriginalVideo' in saved).toBe(false)
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

// 归档层级开关：员工反馈四层文件夹套下来翻不动，改成每层独立勾选。
// 这里只测「勾选 → 保存值」和「全不勾时的状态提示」；实际建目录行为在 organizer 测试里。
describe('SettingsPanel 归档层级开关', () => {
  const FLAT_HINT = '当前：所有视频直接放在下载目录，不分文件夹。'

  it('四项独立勾选：勾按作者只把该键置 true，其余仍为 false', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    fireEvent.click(await screen.findByLabelText('按作者分文件夹'))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      organizeByAuthor: true,
      organizeByCategory: false,
      organizeByOrientation: false,
      organizeByDuration: false
    })))
  })

  it('可同时勾选多层，互不影响', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    fireEvent.click(await screen.findByLabelText('按作者分文件夹'))
    fireEvent.click(screen.getByLabelText('按时长分文件夹'))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      organizeByAuthor: true,
      organizeByDuration: true,
      organizeByCategory: false,
      organizeByOrientation: false
    })))
  })

  it('四项都不勾 → 明确提示视频直接放在下载目录；勾任意一项提示消失', async () => {
    installFakeApi()
    render(<SettingsPanel />)

    expect(await screen.findByText(FLAT_HINT)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('按时长分文件夹'))
    await waitFor(() => expect(screen.queryByText(FLAT_HINT)).toBeNull())
  })

  it('已归档文件不会自动搬家这件事必须写在面板上，不能只靠用户猜', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    expect(await screen.findByText(/已经归好的文件不会自动搬家/)).toBeInTheDocument()
  })
})

// 全关层级时点「整理全部」，旧写法会显示「已整理 0 个作者」——读起来像坏了。
// 这是配置状态不是失败，必须给出能看懂的话。
describe('SettingsPanel 未启用层级时的整理反馈', () => {
  it('整理全部返回 skipped → 提示未开启层级，不说"已整理 0 个作者"', async () => {
    installFakeApi()
    vi.mocked(window.api.organizeAll).mockResolvedValue({ ok: true, count: 0, skipped: true } as never)
    render(<SettingsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: '整理全部' }))

    await waitFor(() => expect(screen.getByText(/未开启任何分类层级/)).toBeInTheDocument())
    expect(screen.queryByText(/已整理 0 个作者/)).toBeNull()
  })

  it('正常整理仍报作者数（不能被 skipped 分支吃掉）', async () => {
    installFakeApi()
    vi.mocked(window.api.organizeAll).mockResolvedValue({ ok: true, count: 2 } as never)
    render(<SettingsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: '整理全部' }))
    await waitFor(() => expect(screen.getByText('已整理 2 个作者')).toBeInTheDocument())
  })
})
