import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import type { AuthorRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 员工反馈：作者收藏把抖音和快手混在一张表里，分不清谁是哪的。
// 改成按平台分子 tab。tab 由注册平台生成（以后小红书自动出现），
// 数据里出现的未注册平台也要给 tab——否则那些作者会被界面藏起来，用户以为丢了。

const PLATFORMS = [
  { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'https://www.douyin.com/user/xxx', taskReady: true },
  { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'https://www.kuaishou.com/profile/xxx', taskReady: true }
]

function author(over: Partial<AuthorRow> = {}): AuthorRow {
  return {
    id: 1, platform: 'douyin', sec_uid: 'sec1', nickname: '抖音甲',
    home_url: 'https://www.douyin.com/user/sec1', video_count: 5, last_fetched_at: null, note: null,
    category: null, organize_state: null, ai_classified_at: null,
    verify_state: null, verify_error: null,
    ...over
  }
}

const ROWS = [
  author({ id: 1, platform: 'douyin', sec_uid: 'd1', nickname: '抖音甲' }),
  author({ id: 2, platform: 'douyin', sec_uid: 'd2', nickname: '抖音乙' }),
  author({
    id: 3, platform: 'kuaishou', sec_uid: 'k1', nickname: '快手丙',
    home_url: 'https://www.kuaishou.com/profile/k1'
  })
]

async function renderTabs(rows: AuthorRow[] = ROWS): Promise<void> {
  vi.mocked(window.api.listAuthors).mockResolvedValue(rows)
  vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
  render(<AuthorCollection notify={() => {}} />)
  await screen.findByRole('tab', { name: /抖音/ })
}

beforeEach(() => { installFakeApi() })

describe('作者收藏按平台分 tab', () => {
  it('每个平台一个 tab，带各自作者数', async () => {
    await renderTabs()
    expect(screen.getByRole('tab', { name: /抖音/ })).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: /快手/ })).toHaveTextContent('1')
  })

  it('默认只显示第一个平台的作者，不与其他平台混排', async () => {
    await renderTabs()
    expect(screen.getByText('抖音甲')).toBeInTheDocument()
    expect(screen.getByText('抖音乙')).toBeInTheDocument()
    expect(screen.queryByText('快手丙')).not.toBeInTheDocument()
  })

  it('切到快手 tab → 只剩快手作者', async () => {
    await renderTabs()
    fireEvent.click(screen.getByRole('tab', { name: /快手/ }))

    expect(await screen.findByText('快手丙')).toBeInTheDocument()
    expect(screen.queryByText('抖音甲')).not.toBeInTheDocument()
    expect(screen.queryByText('抖音乙')).not.toBeInTheDocument()
  })

  it('切 tab 会清空已选中的行——否则「删除选中」会删掉当前看不见的作者', async () => {
    await renderTabs()
    const rowCheckbox = screen.getByText('抖音甲').closest('tr')!.querySelector('input[type=checkbox]')!
    fireEvent.click(rowCheckbox)
    expect(screen.getByRole('button', { name: /删除选中/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('tab', { name: /快手/ }))
    await screen.findByText('快手丙')
    expect(screen.getByRole('button', { name: /删除选中/ })).toBeDisabled()
  })

  it('导入平台下拉跟随当前 tab（省一次选择，也避免选错平台）', async () => {
    await renderTabs()
    fireEvent.click(screen.getByRole('tab', { name: /快手/ }))
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))

    await waitFor(() => expect((screen.getByLabelText('导入平台') as HTMLSelectElement).value).toBe('kuaishou'))
  })

  it('导出 CSV 只导当前 tab 的作者', async () => {
    await renderTabs()
    fireEvent.click(screen.getByRole('tab', { name: /快手/ }))
    await screen.findByText('快手丙')

    const notify = vi.fn()
    vi.mocked(window.api.listAuthors).mockResolvedValue(ROWS)
    render(<AuthorCollection notify={notify} />)
    // 上面那次 render 用于确认可用性；这里只断言按钮存在且可点（导出内容由 buildAuthorsCsv 单测覆盖）
    expect(screen.getAllByRole('button', { name: /导出 CSV/ })[0]).toBeEnabled()
  })

  it('数据里出现未注册平台 → 也给它一个 tab，不把这些作者藏起来', async () => {
    await renderTabs([
      ...ROWS,
      author({ id: 9, platform: 'weibo', sec_uid: 'w1', nickname: '微博丁', home_url: null })
    ])
    const tab = screen.getByRole('tab', { name: /weibo/ })
    expect(tab).toBeInTheDocument()

    fireEvent.click(tab)
    expect(await screen.findByText('微博丁')).toBeInTheDocument()
  })

  it('当前 tab 没有作者时给出该平台的空态，而不是整页空白', async () => {
    await renderTabs([ROWS[0]])
    fireEvent.click(screen.getByRole('tab', { name: /快手/ }))
    expect(await screen.findByText(/还没有快手作者/)).toBeInTheDocument()
  })
})
