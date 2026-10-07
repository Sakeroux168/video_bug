import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SettingsPanel from '../../src/renderer/src/components/SettingsPanel'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-07 自动化（功能 3）：设置页「自动化」——缩到托盘、系统通知、每天定时追更

const save = () => fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

describe('设置 · 自动化', () => {
  it('默认：不缩托盘、开通知、不定时追更；改了按填的保存', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    const tray = await screen.findByLabelText('关窗口时缩到右下角托盘，程序在后台继续跑')
    expect(tray).not.toBeChecked()
    expect(screen.getByLabelText('抓完、需要登录或验证时弹系统通知')).toBeChecked()
    expect(screen.getByLabelText('每天定时追更')).not.toBeChecked()

    fireEvent.click(tray)
    fireEvent.click(screen.getByLabelText('每天定时追更'))
    fireEvent.change(screen.getByLabelText('追更时间'), { target: { value: '21:30' } })
    fireEvent.change(screen.getByLabelText('每个作者最多抓'), { target: { value: '50' } })
    save()
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      closeToTray: true, autoFollowEnabled: true, autoFollowTime: '21:30', autoFollowCount: 50
    })))
  })

  it('追更哪些作者：默认全部爬过主页的；可以改成只追标了的', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    const scope = await screen.findByLabelText('追更哪些作者')
    expect((scope as HTMLSelectElement).value).toBe('all')
    fireEvent.change(scope, { target: { value: 'picked' } })
    save()
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autoFollowScope: 'picked' })))
  })

  it('开机自动启动：默认关；勾上保存', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    const box = await screen.findByLabelText('开机自动启动（启动后缩在托盘，不弹窗口）')
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    save()
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: true })))
  })

  it('每个作者最多抓：超过 200 按 200 存，空或 0 按 1 存', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    fireEvent.change(await screen.findByLabelText('每个作者最多抓'), { target: { value: '500' } })
    save()
    await waitFor(() => expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autoFollowCount: 200 })))
  })

  it('开了定时追更但没开托盘 → 提醒关了窗口就不跑了', async () => {
    installFakeApi()
    render(<SettingsPanel />)
    fireEvent.click(await screen.findByLabelText('每天定时追更'))
    expect(screen.getByText(/关了窗口程序就退出了/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('关窗口时缩到右下角托盘，程序在后台继续跑'))
    expect(screen.queryByText(/关了窗口程序就退出了/)).toBeNull()
  })

  it('显示有几个作者会被追更、上次追更的结果', async () => {
    installFakeApi()
    vi.mocked(window.api.automationStatus).mockResolvedValue({
      lastFollowAt: '2026-10-07T01:00:00.000Z', eligible: 3,
      lastResult: { at: '2026-10-07T01:00:00.000Z', manual: false, authors: 3, created: 2, skipped: 1 }
    })
    render(<SettingsPanel />)
    expect(await screen.findByText(/现在有 3 个作者会被追更/)).toBeInTheDocument()
    expect(screen.getByText(/建了 2 个任务/)).toBeInTheDocument()
  })

  it('「现在追更一次」：建好了说建了几个；没有爬过主页的作者也说清楚', async () => {
    installFakeApi()
    vi.mocked(window.api.followNow).mockResolvedValueOnce({ authors: 2, created: 2, skipped: 0 })
    render(<SettingsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '现在追更一次' }))
    expect(await screen.findByText(/给 2 个作者建了追更任务/)).toBeInTheDocument()

    vi.mocked(window.api.followNow).mockResolvedValueOnce({ authors: 0, created: 0, skipped: 0 })
    fireEvent.click(screen.getByRole('button', { name: '现在追更一次' }))
    expect(await screen.findByText(/还没有爬过主页的作者/)).toBeInTheDocument()
  })
})
