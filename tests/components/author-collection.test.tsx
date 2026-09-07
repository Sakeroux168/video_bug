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
    // 导入现在带平台参数（面板上的平台下拉），默认抖音
    ], 'douyin')
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

  // 用户实测：校验失败只能看到 3 秒的 toast，看不完。根因不是 toast 太短——
  // 而是作者表只在 mount 时拉一次（useEffect 空依赖）、无任何事件订阅，
  // 校验结果写进库后界面永远停在旧数据上。
  it('收到作者校验失败事件 → 自动重拉作者表', async () => {
    let fire: ((e: unknown) => void) | null = null
    vi.mocked(window.api.onTaskProgress).mockImplementation((cb: (e: never) => void) => {
      fire = cb as (e: unknown) => void
      return () => {}
    })
    vi.mocked(window.api.listAuthors).mockResolvedValue([makeAuthor({ verify_state: 'pending' })] as never)
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    const before = vi.mocked(window.api.listAuthors).mock.calls.length

    vi.mocked(window.api.listAuthors).mockResolvedValue([
      makeAuthor({ verify_state: 'failed', verify_error: '主页作者是「王五」，与你填的「张三」对不上' })
    ] as never)
    fire!({ type: 'task:paused', taskId: 1, reason: 'author_mismatch' })

    await waitFor(() => expect(vi.mocked(window.api.listAuthors).mock.calls.length).toBeGreaterThan(before))
    await screen.findByText(/对不上/)
  })

  it('失败原因显示在主页链接下方（常驻，不是一闪而过的 toast）', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([
      makeAuthor({ verify_state: 'failed', verify_error: '主页没取到作者昵称' })
    ] as never)
    const { container } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    const linkCell = Array.from(container.querySelectorAll('td')).find(td => (td.textContent ?? '').includes('douyin.com'))!
    expect(linkCell.textContent).toContain('没取到')
  })

  // 用户诉求：手里有现成的作者表，只要有作者名和主页链接就该能导进来，
  // 不管其他列是什么东西；导出时只要作者 + 主页链接两列。
  it('选 CSV 文件 → 只取作者与链接两列，其余列全部忽略', async () => {
    render(<AuthorCollection notify={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '导入作者' }))

    const csv = `序号,作者昵称,粉丝数,主页链接,备注
1,张三,10万,https://www.douyin.com/user/a,随便写`
    const file = new File([csv], 'authors.csv', { type: 'text/csv' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(file, 'text', { value: async () => csv })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement
      expect(ta.value).toContain('张三')
      expect(ta.value).toContain('https://www.douyin.com/user/a')
      expect(ta.value).not.toContain('粉丝数')
      expect(ta.value).not.toContain('随便写')
    })
  })

  it('导出 CSV 按钮存在，且空库时禁用', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([] as never)
    render(<AuthorCollection notify={() => {}} />)
    const btn = await screen.findByRole('button', { name: /导出 CSV/ })
    expect(btn).toBeDisabled()
  })

  // 用户诉求：框选出想要的行，直接复制到自己的表格里。
  // （不能为了“能选中文本”去动框选——容器必须保持 select-none）
  it('复制所选：未选时禁用；选中后把作者与链接以制表符分隔写入剪贴板', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([
      makeAuthor({ id: 1, nickname: '张三', home_url: 'https://www.douyin.com/user/a' }),
      makeAuthor({ id: 2, sec_uid: 'sec2', nickname: '李四', home_url: 'https://www.douyin.com/user/b' })
    ] as never)
    const { container } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')

    const copyBtn = screen.getByRole('button', { name: /复制所选/ })
    expect(copyBtn).toBeDisabled()

    // 点中第一行
    const row = container.querySelector('tbody tr[data-id="1"]') as HTMLElement
    fireEvent.mouseDown(row, { clientX: 5, clientY: 5 })
    fireEvent.mouseUp(row, { clientX: 5, clientY: 5 })
    fireEvent.click(row)

    const btn = screen.getByRole('button', { name: /复制所选/ })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)

    await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalled())
    const text = vi.mocked(window.api.writeClipboard).mock.calls[0][0] as string
    // 制表符分隔：粘进 Excel 会自动分列
    expect(text).toBe('张三\thttps://www.douyin.com/user/a')
  })

  // 边界（测试工程师第16轮补）：作者表本身不分页（全部作者一次性渲染在一张 table 里，
  // 没有独立的「页」概念——与视频表格不同）。所以「跨页」场景在这个组件里无从谈起；
  // 能验证的等价场景是「全选」：确认全选后复制的是完整选中集（按表格展示顺序），
  // 而不是只复制了最近一次点击命中的行。
  it('全选后复制所选：包含全部作者（按表格展示顺序），不是只复制最后点的那一行', async () => {
    installFakeApi() // 换新的 vi.fn() 实例，避免上一条用例遗留的 writeClipboard 调用记录干扰 calls[0]
    vi.mocked(window.api.listAuthors).mockResolvedValue([
      makeAuthor({ id: 1, sec_uid: 'sec1', nickname: '张三', home_url: 'https://www.douyin.com/user/a' }),
      makeAuthor({ id: 2, sec_uid: 'sec2', nickname: '李四', home_url: 'https://www.douyin.com/user/b' }),
      makeAuthor({ id: 3, sec_uid: 'sec3', nickname: '王五', home_url: null })
    ] as never)
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')

    const selectAllCheckbox = document.querySelector('thead input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(selectAllCheckbox)

    const btn = screen.getByRole('button', { name: /复制所选（3）/ })
    fireEvent.click(btn)

    await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalled())
    const text = vi.mocked(window.api.writeClipboard).mock.calls[0][0] as string
    expect(text).toBe('张三\thttps://www.douyin.com/user/a\n李四\thttps://www.douyin.com/user/b\n王五\t')
  })

  // 边界（测试工程师第16轮补）：AuthorCollection 订阅了 api.onTaskProgress 来在校验结果
  // 写库后自动重拉作者表；useEffect 的清理函数就是 onTaskProgress 返回的退订函数本身
  // （`return api.onTaskProgress(...)`）。组件卸载时 React 必须调用这个清理函数，否则
  // 每次挂载都会在 preload 侧的 ipcRenderer 监听器列表里再堆一个，长期切换 tab 会累积泄漏。
  it('组件卸载时调用 onTaskProgress 返回的退订函数（不泄漏监听器）', async () => {
    const unsubscribe = vi.fn()
    vi.mocked(window.api.onTaskProgress).mockImplementation(() => unsubscribe)
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    const { unmount } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加')
    expect(unsubscribe).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
  // 用户实测：选了 .xlsx（zip）直接当文本读，满屏压缩包字节 + 34 条假失败行。
  it('选到 .xlsx → 给可操作的提示，不把二进制填进文本框', async () => {
    render(<AuthorCollection notify={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '导入作者' }))

    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]).buffer
    const file = new File([zip], 'authors.xlsx')
    Object.defineProperty(file, 'arrayBuffer', { value: async () => zip })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })

    await screen.findByText(/另存为/)
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.value).toBe('')  // 文本框保持干净，不填乱码
  })

  it('GBK 编码的 CSV（中文 Excel 另存为 CSV 的默认编码）能正确读出中文', async () => {
    render(<AuthorCollection notify={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '导入作者' }))

    const ascii = ',https://www.douyin.com/user/a'
    const gbk = new Uint8Array([0xd5, 0xc5, 0xc8, 0xfd, ...Array.from(ascii).map(c => c.charCodeAt(0))]).buffer
    const file = new File([gbk], 'authors.csv')
    Object.defineProperty(file, 'arrayBuffer', { value: async () => gbk })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })

    await waitFor(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement
      expect(ta.value).toContain('张三')
      expect(ta.value).not.toContain('�')
    })
  })

  // 用户实测：「复制所选」一次把作者+链接都给了，但有时只想要其中一列。
  it('只复制作者 / 只复制链接：各自只给一列，换行分隔', async () => {
    vi.mocked(window.api.listAuthors).mockResolvedValue([
      makeAuthor({ id: 1, nickname: '张三', home_url: 'https://www.douyin.com/user/a' }),
      makeAuthor({ id: 2, sec_uid: 'sec2', nickname: '李四', home_url: 'https://www.douyin.com/user/b' })
    ] as never)
    const { container } = render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')

    // 全选两行
    const head = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(head)

    fireEvent.click(screen.getByRole('button', { name: /只复制作者/ }))
    await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalled())
    expect(vi.mocked(window.api.writeClipboard).mock.calls.at(-1)![0]).toBe('张三\n李四')

    fireEvent.click(screen.getByRole('button', { name: /只复制链接/ }))
    await waitFor(() => expect(vi.mocked(window.api.writeClipboard).mock.calls.length).toBeGreaterThan(1))
    expect(vi.mocked(window.api.writeClipboard).mock.calls.at(-1)![0])
      .toBe('https://www.douyin.com/user/a\nhttps://www.douyin.com/user/b')
  })

  it('未选中时两个单列复制按钮都禁用', async () => {
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByText('张三')
    expect(screen.getByRole('button', { name: /只复制作者/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /只复制链接/ })).toBeDisabled()
  })

})

// D 阶段：导入面板以前不带平台，粘快手链接会被抖音解析器拒绝且提示说的是抖音。
// 现在面板上有平台下拉，选什么平台就用什么平台解析、落库。
describe('AuthorCollection 批量导入按平台', () => {
  const PLATFORMS = [
    { name: 'douyin', displayName: '抖音', authorInputPlaceholder: 'https://www.douyin.com/user/xxx' },
    { name: 'kuaishou', displayName: '快手', authorInputPlaceholder: 'https://www.kuaishou.com/profile/xxx' }
  ]

  async function openImportPanel(): Promise<void> {
    installFakeApi()
    vi.mocked(window.api.listAuthors).mockResolvedValue([])
    vi.mocked(window.api.listPlatforms).mockResolvedValue(PLATFORMS as never)
    render(<AuthorCollection notify={() => {}} />)
    await screen.findByRole('button', { name: '导入作者' })
    fireEvent.click(screen.getByRole('button', { name: '导入作者' }))
    await screen.findByLabelText('导入平台')
  }

  it('导入面板有平台下拉，默认抖音', async () => {
    await openImportPanel()
    expect((screen.getByLabelText('导入平台') as HTMLSelectElement).value).toBe('douyin')
    expect(screen.getByRole('option', { name: '快手' })).toBeInTheDocument()
  })

  it('选快手后粘贴 → importAuthors 收到 kuaishou', async () => {
    await openImportPanel()
    fireEvent.change(screen.getByLabelText('导入平台'), { target: { value: 'kuaishou' } })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '快手作者 https://www.kuaishou.com/profile/3xAUTHOR1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确定导入' }))

    await waitFor(() => expect(window.api.importAuthors).toHaveBeenCalledWith(
      [{ nickname: '快手作者', url: 'https://www.kuaishou.com/profile/3xAUTHOR1' }],
      'kuaishou'
    ))
  })

  it('粘贴示例跟随所选平台，不再永远写着 douyin.com', async () => {
    await openImportPanel()
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(box.placeholder).toContain('douyin.com')

    fireEvent.change(screen.getByLabelText('导入平台'), { target: { value: 'kuaishou' } })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).toContain('kuaishou.com')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).placeholder).not.toContain('douyin.com')
  })
})
