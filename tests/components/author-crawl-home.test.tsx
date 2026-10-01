import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import type { AuthorRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 员工反馈：点「爬主页」直接就开跑，写死 200 条 + 自动下载，没人问过他要爬多少。
// 200 条自动下载 = 一晚上几十 GB，且当时只想看看这个作者有什么。
// 改成先让他填。

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'y', taskReady: true }
]

function author(over: Partial<AuthorRow> = {}): AuthorRow {
  return {
    id: 1, platform: 'kuaishou', sec_uid: '3xA1', nickname: '快手甲',
    home_url: 'https://www.kuaishou.com/profile/3xA1', video_count: 5,
    last_fetched_at: null, note: null, category: null,
    organize_state: null, ai_classified_at: null,
    verify_state: null, verify_error: null,
    ...over
  }
}

async function open(rows: AuthorRow[] = [author()]): Promise<void> {
  vi.mocked(window.api.listAuthors).mockResolvedValue(rows)
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  render(<AuthorCollection notify={() => {}} />)
  // 作者收藏按平台分 tab，默认停在第一个平台（抖音）；这些用例的作者是快手的，先切过去
  fireEvent.click(await screen.findByRole('tab', { name: /快手/ }))
  await screen.findByText(rows[0].nickname)
}

/** 点某一行的「爬主页」 */
function clickCrawl(nickname: string): void {
  const row = screen.getByText(nickname).closest('tr')!
  fireEvent.click(Array.from(row.querySelectorAll('button')).find(b => b.textContent === '爬主页')!)
}

beforeEach(() => { installFakeApi() })

it('小红书作者主页抓取已接入，入口可用', async () => {
  vi.mocked(window.api.listAuthors).mockResolvedValue([author({ platform: 'xiaohongshu', nickname: '小红书甲' })])
  vi.mocked(window.api.listPlatforms).mockResolvedValue([...PLATFORMS,
    { name: 'xiaohongshu', displayName: '小红书', authorInputPlaceholder: 'x', taskReady: true,
      supportedTaskTypes: ['keyword', 'author', 'hashtag'] }
  ] as never)
  render(<AuthorCollection notify={() => {}} />)
  fireEvent.click(await screen.findByRole('tab', { name: /小红书/ }))
  await screen.findByText('小红书甲')
  expect(screen.getByRole('button', { name: '爬主页' })).toBeEnabled()
})

describe('爬主页前先问清楚爬多少', () => {
  it('点「爬主页」不立刻建任务，先出确认面板并写明是哪个作者', async () => {
    await open()
    clickCrawl('快手甲')

    expect(await screen.findByText(/爬取「快手甲」的主页/)).toBeInTheDocument()
    expect(window.api.createTask).not.toHaveBeenCalled()
  })

  it('默认 20 条、自动下载（C 组：说明书一直建议先填 20，200 条容易被风控）', async () => {
    await open()
    clickCrawl('快手甲')

    expect((await screen.findByLabelText('目标数量') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('自动下载') as HTMLInputElement).checked).toBe(true)
  })

  it('改成 20 条 + 手动挑选 → 按填的值建任务', async () => {
    await open()
    clickCrawl('快手甲')

    fireEvent.change(await screen.findByLabelText('目标数量'), { target: { value: '20' } })
    fireEvent.click(screen.getByLabelText('手动挑选'))
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))

    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'kuaishou',
      type: 'author',
      query: '3xA1',
      autoDownload: false,
      filters: expect.objectContaining({ targetCount: 20 })
    })))
  })

  it('数量非法（0 / 1001 / 空）→ 开始按钮禁用，不让建一个必然出问题的任务', async () => {
    await open()
    clickCrawl('快手甲')
    const box = await screen.findByLabelText('目标数量')

    for (const bad of ['0', '1001', '', 'abc']) {
      fireEvent.change(box, { target: { value: bad } })
      expect(screen.getByRole('button', { name: '开始爬取' })).toBeDisabled()
    }
    fireEvent.change(box, { target: { value: '50' } })
    expect(screen.getByRole('button', { name: '开始爬取' })).toBeEnabled()
  })

  it('取消 → 面板收起，一个任务都不建', async () => {
    await open()
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByText(/爬取「快手甲」的主页/)).toBeNull())
    expect(window.api.createTask).not.toHaveBeenCalled()
  })

  it('开始后面板收起，不会重复提交', async () => {
    await open()
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByRole('button', { name: '开始爬取' }))

    await waitFor(() => expect(screen.queryByText(/爬取「快手甲」的主页/)).toBeNull())
    expect(window.api.createTask).toHaveBeenCalledTimes(1)
  })

  it('换一个作者点爬主页 → 面板跟着换人，不会拿上一个人的设置去爬', async () => {
    await open([author(), author({ id: 2, sec_uid: '3xA2', nickname: '快手乙' })])
    clickCrawl('快手甲')
    await screen.findByText(/爬取「快手甲」的主页/)

    clickCrawl('快手乙')
    expect(await screen.findByText(/爬取「快手乙」的主页/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({ query: '3xA2' })))
  })
})

// R20：用户要的「用户页可以自己选择时间，选什么时间到什么时间内的视频」——可选功能，默认不勾 = 原行为
describe('爬主页：可选「只要这段时间发的」（R20）', () => {
  it('默认不勾：不显示日期框，按原来的「不限时间」建任务', async () => {
    await open()
    clickCrawl('快手甲')
    await screen.findByText(/爬取「快手甲」的主页/)

    expect((screen.getByLabelText('只要这段时间发的') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('从')).toBeNull()
    expect(screen.queryByLabelText('到')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalled())
    const arg = vi.mocked(window.api.createTask).mock.calls[0][0]
    expect(arg.filters).toEqual({ timeRange: 'all', duration: 'all', targetCount: 20 })
    expect(arg.allowDuplicateAuthor).toBeUndefined()
  })

  it('勾上并选「从」「到」→ 按北京时间日期段建任务（custom + startDate/endDate），且不被「已爬过」去重拦掉', async () => {
    await open()
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByLabelText('只要这段时间发的'))
    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('到'), { target: { value: '2026-09-20' } })
    expect(screen.getByText(/只要 2026-09-01 到 2026-09-20 发的/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'author',
      query: '3xA1',
      allowDuplicateAuthor: true,
      filters: expect.objectContaining({ timeRange: 'custom', startDate: '2026-09-01', endDate: '2026-09-20', targetCount: 20 })
    })))
  })

  it('只填「从」也行（从那天到现在）；只填「到」也行（那天及以前）', async () => {
    await open()
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByLabelText('只要这段时间发的'))
    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-01' } })
    expect(screen.getByText(/只要 2026-09-01 以后发的/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalled())
    const f = vi.mocked(window.api.createTask).mock.calls[0][0].filters
    expect(f.timeRange).toBe('custom')
    expect(f.startDate).toBe('2026-09-01')
    expect(f.endDate).toBeUndefined()
  })

  it('勾了但一个日期都没选 / 开始晚于结束 → 开始按钮禁用并给出提示', async () => {
    await open()
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByLabelText('只要这段时间发的'))
    expect(screen.getByRole('button', { name: '开始爬取' })).toBeDisabled()
    expect(screen.getByText('请至少选一个日期')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-20' } })
    fireEvent.change(screen.getByLabelText('到'), { target: { value: '2026-09-01' } })
    expect(screen.getByRole('button', { name: '开始爬取' })).toBeDisabled()
    expect(screen.getByText('开始日期不能晚于结束日期')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('到'), { target: { value: '2026-09-20' } })
    expect(screen.getByRole('button', { name: '开始爬取' })).toBeEnabled()
    expect(screen.getByText(/只要 2026-09-20 当天发的/)).toBeInTheDocument()
  })

  it('取消勾选 → 日期不再生效，又按不限时间建任务', async () => {
    await open()
    clickCrawl('快手甲')
    const box = await screen.findByLabelText('只要这段时间发的')
    fireEvent.click(box)
    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-20' } })
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalled())
    expect(vi.mocked(window.api.createTask).mock.calls[0][0].filters.timeRange).toBe('all')
  })

  it('换一个作者 → 日期段不会带到下一个人身上', async () => {
    await open([author(), author({ id: 2, sec_uid: '3xA2', nickname: '快手乙' })])
    clickCrawl('快手甲')
    fireEvent.click(await screen.findByLabelText('只要这段时间发的'))
    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-01' } })

    clickCrawl('快手乙')
    await screen.findByText(/爬取「快手乙」的主页/)
    expect((screen.getByLabelText('只要这段时间发的') as HTMLInputElement).checked).toBe(false)
  })
})
