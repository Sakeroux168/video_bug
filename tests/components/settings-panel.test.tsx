import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettingsPanel from '../../src/renderer/src/components/SettingsPanel'
import { installFakeApi } from '../helpers/fake-api'

// P3 里唯一允许的行为改动：成功与失败此前共用同一个绿色 span，
// 「AI 连接失败：xxx」会被渲染成绿色——用户一眼看过去以为成功了。
// 这里破例断言颜色类，因为**被测的就是颜色语义本身**；同时断言文案，
// 保证不是只测样式（否则把文案改没了测试也会绿）。

function msgEl(container: HTMLElement): HTMLElement | null {
  return Array.from(container.querySelectorAll('span'))
    .find(el => /连接正常|连接失败/.test(el.textContent ?? '')) ?? null
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
