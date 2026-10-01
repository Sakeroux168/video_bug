import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import type { AuthorRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// C 组：作者追更 + 批量爬（体验测试 老陈 🔴1、🟠8、🟠9、🟡17，功能建议 1、2、4）

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'x', taskReady: true },
  { name: 'xiaohongshu', displayName: '小红书', authorInputPlaceholder: 'y', taskReady: true, supportedTaskTypes: ['keyword', 'author', 'hashtag'] }
]

function author(over: Partial<AuthorRow> = {}): AuthorRow {
  return {
    id: 1, platform: 'xiaohongshu', sec_uid: 'U1', nickname: '爬过的博主',
    home_url: 'https://www.xiaohongshu.com/user/profile/U1', video_count: 6,
    last_fetched_at: null, note: null, category: null, organize_state: null, ai_classified_at: null,
    verify_state: null, verify_error: null,
    // 北京时间 2026-09-28 01:30 发的（UTC 还是 27 号）——起点必须按北京时间算成 28 号
    latest_video_at: '2026-09-27T17:30:00.000Z',
    last_crawled_at: '2026-09-29T02:00:00.000Z',
    ...over
  }
}
const fresh = (over: Partial<AuthorRow> = {}): AuthorRow =>
  author({ id: 2, sec_uid: 'U2', nickname: '没爬过的博主', video_count: 1, latest_video_at: null, last_crawled_at: null, ...over })

const notify = vi.fn()
async function open(rows: AuthorRow[]): Promise<void> {
  vi.mocked(window.api.listAuthors).mockResolvedValue(rows)
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  render(<AuthorCollection notify={notify} />)
  fireEvent.click(await screen.findByRole('tab', { name: /小红书/ }))
  await screen.findByText(rows[0].nickname)
}
function row(nickname: string): HTMLElement { return screen.getByText(nickname).closest('tr')! }
function clickCrawl(nickname: string): void {
  fireEvent.click(within(row(nickname)).getByRole('button', { name: '爬主页' }))
}

beforeEach(() => { installFakeApi(); notify.mockReset(); try { localStorage.clear() } catch { /* jsdom */ } })

describe('爬过的博主：不再被「已爬过」拦掉，默认只抓新视频', () => {
  it('弹窗写明上次爬取时间，并默认选中「只抓新视频」，起点是库里最新视频的北京时间日期', async () => {
    await open([author()])
    clickCrawl('爬过的博主')
    expect(await screen.findByText(/上次爬取：2026-09-29/)).toBeInTheDocument()
    const onlyNew = screen.getByLabelText(/只抓新视频/) as HTMLInputElement
    expect(onlyNew.checked).toBe(true)
    expect(screen.getByText(/2026-09-28 及以后发的/)).toBeInTheDocument()
  })

  it('只抓新视频 → custom 日期段（startDate=北京时间日期）+ 允许重复爬，目标数量默认 20', async () => {
    await open([author()])
    clickCrawl('爬过的博主')
    fireEvent.click(await screen.findByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'xiaohongshu', type: 'author', query: 'U1', allowDuplicateAuthor: true,
      filters: { timeRange: 'custom', startDate: '2026-09-28', duration: 'all', targetCount: 20 }
    })))
  })

  it('选「全部重新爬」→ 不限时间 + 允许重复爬', async () => {
    await open([author()])
    clickCrawl('爬过的博主')
    fireEvent.click(await screen.findByLabelText('全部重新爬'))
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      allowDuplicateAuthor: true,
      filters: { timeRange: 'all', duration: 'all', targetCount: 20 }
    })))
  })

  it('勾了「只要这段时间发的」→ 以手填日期段为准', async () => {
    await open([author()])
    clickCrawl('爬过的博主')
    fireEvent.click(await screen.findByLabelText('只要这段时间发的'))
    fireEvent.change(screen.getByLabelText('从'), { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalled())
    const arg = vi.mocked(window.api.createTask).mock.calls[0][0]
    expect(arg.filters).toEqual(expect.objectContaining({ timeRange: 'custom', startDate: '2026-09-01' }))
  })

  it('库里没有这个博主的视频、但爬过主页 → 从上次爬取那天起抓', async () => {
    await open([author({ latest_video_at: null })])
    clickCrawl('爬过的博主')
    fireEvent.click(await screen.findByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ timeRange: 'custom', startDate: '2026-09-29' })
    })))
  })

  it('没爬过的博主：没有「只抓新视频」，按不限时间建任务，也不带允许重复', async () => {
    await open([fresh()])
    clickCrawl('没爬过的博主')
    await screen.findByText(/爬取「没爬过的博主」的主页/)
    expect(screen.queryByLabelText(/只抓新视频/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '开始爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalled())
    const arg = vi.mocked(window.api.createTask).mock.calls[0][0]
    expect(arg.filters).toEqual({ timeRange: 'all', duration: 'all', targetCount: 20 })
    expect(arg.allowDuplicateAuthor).toBeUndefined()
  })
})

describe('勾选多个博主一次批量爬', () => {
  it('勾两个 → 出现「爬选中的主页（2）」；开始后每人各建一个任务，爬过的只抓新视频', async () => {
    await open([author(), fresh()])
    expect(screen.queryByRole('button', { name: /爬选中的主页/ })).toBeNull()
    fireEvent.click(within(row('爬过的博主')).getByRole('checkbox'))
    fireEvent.click(within(row('没爬过的博主')).getByRole('checkbox'), { ctrlKey: true })
    fireEvent.click(await screen.findByRole('button', { name: '爬选中的主页（2）' }))
    expect((screen.getByLabelText('批量目标数量') as HTMLInputElement).value).toBe('20')
    fireEvent.click(screen.getByRole('button', { name: '开始批量爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(window.api.createTask).mock.calls.map(c => c[0])
    expect(calls.find(c => c.query === 'U1')).toEqual(expect.objectContaining({
      allowDuplicateAuthor: true,
      filters: { timeRange: 'custom', startDate: '2026-09-28', duration: 'all', targetCount: 20 }
    }))
    expect(calls.find(c => c.query === 'U2')!.filters).toEqual({ timeRange: 'all', duration: 'all', targetCount: 20 })
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/已建 2 个任务/), expect.anything()))
  })

  it('选「全部重新爬」→ 每人都不限时间且允许重复；有被跳过的要说清楚是谁、为什么', async () => {
    vi.mocked(window.api.createTask)
      .mockResolvedValueOnce({ id: 11, skipped: false })
      .mockResolvedValueOnce({ id: null, skipped: true, reason: '校验失败' })
    await open([author(), fresh()])
    fireEvent.click(within(row('爬过的博主')).getByRole('checkbox'))
    fireEvent.click(within(row('没爬过的博主')).getByRole('checkbox'), { ctrlKey: true })
    fireEvent.click(await screen.findByRole('button', { name: '爬选中的主页（2）' }))
    fireEvent.click(screen.getByLabelText('批量全部重新爬'))
    fireEvent.click(screen.getByRole('button', { name: '开始批量爬取' }))
    await waitFor(() => expect(window.api.createTask).toHaveBeenCalledTimes(2))
    for (const c of vi.mocked(window.api.createTask).mock.calls) {
      expect(c[0]).toEqual(expect.objectContaining({ allowDuplicateAuthor: true, filters: { timeRange: 'all', duration: 'all', targetCount: 20 } }))
    }
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/已建 1 个任务.*跳过 1 个.*没爬过的博主.*校验失败/), expect.anything()))
  })
})

describe('面板要出现在眼前', () => {
  it('在长列表下方点「爬主页」/「爬选中的主页」→ 面板自动滚到可见位置（真机：面板开在顶部，用户以为没反应）', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await open([author(), fresh()])
    clickCrawl('爬过的博主')
    await screen.findByText(/爬取「爬过的博主」的主页/)
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    scroll.mockClear()
    fireEvent.click(within(row('没爬过的博主')).getByRole('checkbox'))
    fireEvent.click(await screen.findByRole('button', { name: '爬选中的主页（1）' }))
    await waitFor(() => expect(scroll).toHaveBeenCalled())
  })
})

describe('作者表格', () => {
  it('多两列：上次爬取、最新视频（北京时间日期，没有就写 —）', async () => {
    await open([author(), fresh()])
    expect(screen.getByRole('columnheader', { name: /上次爬取/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /最新视频/ })).toBeInTheDocument()
    expect(within(row('爬过的博主')).getByText('2026-09-29')).toBeInTheDocument()
    expect(within(row('爬过的博主')).getByText('2026-09-28')).toBeInTheDocument()
    expect(within(row('没爬过的博主')).getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('默认按加入顺序；点「视频数」表头才按视频数排', async () => {
    await open([fresh({ id: 1, nickname: '先加入', video_count: 1 }), author({ id: 2, nickname: '后加入', video_count: 9 })])
    const names = (): string[] => screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[1].textContent ?? '')
    expect(names()[0]).toContain('先加入')
    fireEvent.click(screen.getByRole('button', { name: /视频数/ }))
    expect(names()[0]).toContain('后加入')
  })

  it('记住上次选的平台标签', async () => {
    try { localStorage.setItem('authorCollection.tab', 'xiaohongshu') } catch { /* jsdom */ }
    vi.mocked(window.api.listAuthors).mockResolvedValue([author()])
    vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
    render(<AuthorCollection notify={notify} />)
    expect(await screen.findByText('爬过的博主')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /小红书/ })).toHaveAttribute('aria-selected', 'true')
  })
})
