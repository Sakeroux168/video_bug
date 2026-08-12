import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AuthorCollection from '../../src/renderer/src/components/AuthorCollection'
import type { AuthorRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 批量导入作者的内联界面：工具条「导入作者」按钮 → 展开 textarea → 确定导入 → api.importAuthors
// → 成功后 refresh（api.listAuthors 再调一次）→ 结果内联展示（失败行行号 + 原始文本 + reason）。
// 重点锁住：authors.length === 0 时表格容器整个不渲染，导入入口必须在那个三元之外仍可见。

function makeAuthor(overrides: Partial<AuthorRow> = {}): AuthorRow {
  return {
    id: 1, platform: 'douyin', sec_uid: 'sec1', nickname: '张三',
    home_url: 'https://www.douyin.com/user/sec1', video_count: 5, last_fetched_at: null, note: null,
    category: null, organize_state: null, ai_classified_at: null,
    verify_state: null, verify_error: null,
    ...overrides
  }
}

describe('AuthorCollection 批量导入作者', () => {
  it('空库时也能看到「导入作者」入口（表格容器在 authors.length===0 时不渲染，按钮不能被三元挡住）', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    expect(screen.getByRole('button', { name: '导入作者' })).toBeTruthy()
  })

  it('点「导入作者」出现 textarea', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('粘 3 行点确定 → api.importAuthors 被调用且收到 3 条 {nickname, url}', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    vi.mocked(window.api.importAuthors).mockResolvedValue({
      created: 3,
      results: [
        { line: 1, raw: '张三 https://www.douyin.com/user/a', ok: true },
        { line: 2, raw: '李四 https://www.douyin.com/user/b', ok: true },
        { line: 3, raw: '王五 https://www.douyin.com/user/c', ok: true }
      ]
    })
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: {
        value: [
          '张三 https://www.douyin.com/user/a',
          '李四 https://www.douyin.com/user/b',
          '王五 https://www.douyin.com/user/c'
        ].join('\n')
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '确定导入' }))
    await waitFor(() => expect(window.api.importAuthors).toHaveBeenCalledTimes(1))
    expect(window.api.importAuthors).toHaveBeenCalledWith([
      { nickname: '张三', url: 'https://www.douyin.com/user/a' },
      { nickname: '李四', url: 'https://www.douyin.com/user/b' },
      { nickname: '王五', url: 'https://www.douyin.com/user/c' }
    ])
  })

  it('导入成功后 api.listAuthors 被再次调用（refresh 生效）', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    vi.mocked(window.api.importAuthors).mockResolvedValue({
      created: 1,
      results: [{ line: 1, raw: '张三 https://www.douyin.com/user/a', ok: true }]
    })
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    const callsBefore = vi.mocked(window.api.listAuthors).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '张三 https://www.douyin.com/user/a' } })
    fireEvent.click(screen.getByRole('button', { name: '确定导入' }))
    await waitFor(() => expect(vi.mocked(window.api.listAuthors).mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('主进程返回含失败行时，失败行的行号与 reason 渲染在界面上', async () => {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    vi.mocked(window.api.importAuthors).mockResolvedValue({
      created: 1,
      results: [
        { line: 1, raw: '张三 https://www.douyin.com/user/a', ok: true },
        { line: 2, raw: '李四', ok: false, reason: '未识别到抖音主页链接' }
      ]
    })
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '张三 https://www.douyin.com/user/a\n李四' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确定导入' }))
    const failItem = await screen.findByText(/未识别到抖音主页链接/)
    // 失败行的行号 + 原始文本 + reason 应在同一条列表项里，方便用户对照修改
    expect(failItem.closest('li')?.textContent).toMatch(/第\s*2\s*行/)
    expect(failItem.closest('li')?.textContent).toMatch(/李四/)
  })

  it('点「导入作者」按钮不改变行选中态（顺带覆盖 closest 守卫）', async () => {
    installFakeApi()
    const author = makeAuthor()
    vi.mocked(window.api.listAuthors).mockResolvedValue([author])
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    const row = screen.getByText('张三').closest('tr')!
    fireEvent.click(row)
    expect(row.getAttribute('data-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    expect(row.getAttribute('data-selected')).toBe('true')
  })
  it('待校验 / 校验失败 的作者在表里有明确标识与原因', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([
      { id: 1, platform: 'douyin', sec_uid: 'S1', nickname: '张三', home_url: 'u1', video_count: 0,
        last_fetched_at: null, note: null, category: null, organize_state: null, ai_classified_at: null,
        verify_state: 'pending', verify_error: null },
      { id: 2, platform: 'douyin', sec_uid: 'S2', nickname: '李四', home_url: 'u2', video_count: 0,
        last_fetched_at: null, note: null, category: null, organize_state: null, ai_classified_at: null,
        verify_state: 'failed', verify_error: '主页作者是「王五」，与你填的「李四」对不上' },
      { id: 3, platform: 'douyin', sec_uid: 'S3', nickname: '王五', home_url: 'u3', video_count: 5,
        last_fetched_at: null, note: null, category: null, organize_state: null, ai_classified_at: null,
        verify_state: null, verify_error: null }
    ] as never)
    const { container } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    const text = container.textContent ?? ''
    expect(text).toContain('待校验')
    expect(text).toContain('对不上')
    // 抓取自动收录的（verify_state=null）不应出现任何校验标识
    const row3 = Array.from(container.querySelectorAll('tbody tr')).find(r => (r.textContent ?? '').includes('王五'))!
    expect(row3.textContent).not.toContain('待校验')
  })

})
