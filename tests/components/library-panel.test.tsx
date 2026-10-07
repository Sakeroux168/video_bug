import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import LibraryPanel from '../../src/renderer/src/components/LibraryPanel'
import App from '../../src/renderer/src/App'
import type { LibraryRow } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-07 功能 E（素材库）：用封面缩略图浏览下载过的视频；筛选、排序、标记、备注、播放

function row(id: number, over: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `a${id}`, title: `视频${id}`, author_id: 1, play_addr: null,
    source_url: null, cover_url: null, cover_path: `D:/下载/${id}.jpg`, original_path: null, normalization_error: null,
    video_width: 1080, video_height: 1920, duration: 75, publish_time: '2026-10-01T00:00:00.000Z',
    stats: '{"likes":12345,"collects":678}', ai_verdict: null, ai_tags: null, status: 'done',
    local_path: `D:/下载/${id}.mp4`, file_size: 5 * 1024 * 1024, error: null, retry_count: 0,
    fetched_at: '', downloaded_at: '2026-10-02T00:00:00.000Z', author_nickname: '作者', task_query: '猫咪',
    mark: null, note: null, ...over
  } as LibraryRow
}

async function setup(rows: LibraryRow[], total = rows.length, onOpenProcess = vi.fn()) {
  installFakeApi()
  vi.mocked(window.api.listLibrary).mockResolvedValue({ rows, total })
  vi.mocked(window.api.listLibraryTasks).mockResolvedValue([{ id: 1, platform: 'douyin', type: 'keyword', query: '猫咪', count: 2 }])
  const notify = vi.fn()
  render(<LibraryPanel notify={notify} onOpenProcess={onOpenProcess} />)
  if (rows.length) await screen.findByText(rows[0].title)
  return notify
}
const card = (title: string) => screen.getByText(title).closest('[data-library-card]') as HTMLElement

describe('素材库', () => {
  it('左侧导航有「素材库」，点了打开', async () => {
    installFakeApi()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '素材库' }))
    await waitFor(() => expect(window.api.listLibrary).toHaveBeenCalled())
  })

  it('每条一张卡片：封面、标题、作者、关键词、点赞 / 收藏、时长、分辨率', async () => {
    await setup([row(1)])
    const c = card('视频1')
    expect(c.querySelector('img')?.getAttribute('src')).toBe('vs-cover://video/1')
    expect(c.textContent).toContain('作者')
    expect(c.textContent).toContain('猫咪')
    expect(c.textContent).toContain('1.2w')
    expect(c.textContent).toContain('678')
    expect(c.textContent).toContain('1:15')
    expect(c.textContent).toContain('1080×1920')
  })

  it('筛选和排序都交给主进程查（搜索、平台、关键词、标记、排序），换条件回到第 1 页', async () => {
    await setup([row(1)])
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'likes' } })
    fireEvent.change(screen.getByLabelText('标记'), { target: { value: 'star' } })
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '1' } })
    fireEvent.change(screen.getByPlaceholderText('搜标题 / 作者 / 备注'), { target: { value: '橘猫' } })
    await waitFor(() => expect(window.api.listLibrary).toHaveBeenLastCalledWith(expect.objectContaining({
      sort: 'likes', mark: 'star', taskId: 1, search: '橘猫', page: 1
    })))
  })

  it('标记：点「星标」打上，再点一次取消；已用的卡片变淡', async () => {
    await setup([row(1), row(2, { title: '视频2', mark: 'used' })])
    fireEvent.click(within(card('视频1')).getByRole('button', { name: '星标' }))
    await waitFor(() => expect(window.api.markVideos).toHaveBeenCalledWith([1], 'star'))
    expect(card('视频2').className).toMatch(/opacity-60/)
    fireEvent.click(within(card('视频2')).getByRole('button', { name: '已用' }))
    await waitFor(() => expect(window.api.markVideos).toHaveBeenCalledWith([2], null))
    await waitFor(() => expect(card('视频2').className).not.toMatch(/opacity-60/))
  })

  it('备注：点「备注」写，回车保存', async () => {
    await setup([row(1)])
    fireEvent.click(within(card('视频1')).getByRole('button', { name: '备注' }))
    const input = within(card('视频1')).getByPlaceholderText('写点备注，回车保存')
    fireEvent.change(input, { target: { value: '开头能用' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(window.api.noteVideo).toHaveBeenCalledWith(1, '开头能用'))
  })

  it('播放 / 在文件夹中显示：只传视频 id；找不到文件时提示', async () => {
    const notify = await setup([row(1)])
    vi.mocked(window.api.playVideo).mockResolvedValue({ ok: false, error: '找不到这个视频文件' })
    fireEvent.click(within(card('视频1')).getByRole('button', { name: '播放' }))
    await waitFor(() => expect(window.api.playVideo).toHaveBeenCalledWith(1))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('找不到这个视频文件'))
    fireEvent.click(within(card('视频1')).getByRole('button', { name: '在文件夹中显示' }))
    expect(window.api.locateLibraryVideo).toHaveBeenCalledWith(1)
  })

  it('翻页：显示共几条、第几页', async () => {
    await setup([row(1)], 130)
    expect(screen.getByText('共 130 条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(window.api.listLibrary).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })))
  })

  it('还没有下载过视频：提示去任务页抓', async () => {
    await setup([])
    expect(await screen.findByText(/还没有下载完成的视频/)).toBeInTheDocument()
  })

  // 2026-10-07 素材库第二部分：多选 → 批量标记 / 打包交付（可顺便统一分辨率）
  describe('多选', () => {
    const pick = (title: string) => fireEvent.click(within(card(title)).getByRole('checkbox', { name: `选中 ${title}` }))
    const exported = (over = {}) => ({
      ok: true, result: { copied: 2, missing: 0, failed: 0, csvPath: 'E:/交付/来源清单.csv', dir: 'E:/交付', files: [] }, ...over
    })

    it('勾两条 → 显示「已选 2 条」；批量标成待用', async () => {
      await setup([row(1), row(2, { title: '视频2' })])
      expect(screen.queryByText(/已选/)).toBeNull()
      pick('视频1'); pick('视频2')
      expect(screen.getByText('已选 2 条')).toBeInTheDocument()
      fireEvent.click(within(screen.getByTestId('library-selection')).getByRole('button', { name: '标为待用' }))
      await waitFor(() => expect(window.api.markVideos).toHaveBeenCalledWith([1, 2], 'todo'))
    })

    it('「全选本页」「清空」', async () => {
      await setup([row(1), row(2, { title: '视频2' })])
      pick('视频1')
      fireEvent.click(screen.getByRole('button', { name: '全选本页' }))
      expect(screen.getByText('已选 2 条')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '清空' }))
      expect(screen.queryByText(/已选/)).toBeNull()
    })

    it('打包交付：默认交付后标「已用」、不转码；完成后显示结果和「打开文件夹」', async () => {
      await setup([row(1), row(2, { title: '视频2' })])
      vi.mocked(window.api.exportLibrary).mockResolvedValue(exported())
      pick('视频1'); pick('视频2')
      fireEvent.click(screen.getByRole('button', { name: '打包交付…' }))
      expect(screen.getByLabelText(/交付后标为「已用」/)).toBeChecked()
      expect(screen.getByLabelText(/顺便统一分辨率/)).not.toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: '选文件夹并开始' }))
      await waitFor(() => expect(window.api.exportLibrary).toHaveBeenCalledWith([1, 2], { markUsed: true, normalize: false }))
      const done = await screen.findByTestId('library-export-done')
      expect(done.textContent).toContain('已复制 2 条')
      expect(done.textContent).toContain('来源清单')
      fireEvent.click(within(done).getByRole('button', { name: '打开文件夹' }))
      expect(window.api.openDir).toHaveBeenCalledWith('E:/交付')
    })

    it('勾「顺便统一分辨率」→ 开始后能一键去「视频处理」看进度；有找不到的文件要说出来', async () => {
      const onOpenProcess = vi.fn()
      await setup([row(1)], 1, onOpenProcess)
      vi.mocked(window.api.exportLibrary).mockResolvedValue(exported({
        processing: true, result: { copied: 1, missing: 1, failed: 0, csvPath: 'E:/交付/来源清单.csv', dir: 'E:/交付', files: [] }
      }))
      pick('视频1')
      fireEvent.click(screen.getByRole('button', { name: '打包交付…' }))
      fireEvent.click(screen.getByLabelText(/顺便统一分辨率/))
      fireEvent.click(screen.getByRole('button', { name: '选文件夹并开始' }))
      await waitFor(() => expect(window.api.exportLibrary).toHaveBeenCalledWith([1], { markUsed: true, normalize: true }))
      const done = await screen.findByTestId('library-export-done')
      expect(done.textContent).toContain('1 条找不到文件')
      fireEvent.click(within(done).getByRole('button', { name: '去看进度' }))
      expect(onOpenProcess).toHaveBeenCalled()
    })

    it('统一分辨率没能开始（上一轮还在跑）→ 说原因', async () => {
      await setup([row(1)])
      vi.mocked(window.api.exportLibrary).mockResolvedValue(exported({ processing: false, processError: '当前还有一轮处理没结束，请先停止' }))
      pick('视频1')
      fireEvent.click(screen.getByRole('button', { name: '打包交付…' }))
      fireEvent.click(screen.getByLabelText(/顺便统一分辨率/))
      fireEvent.click(screen.getByRole('button', { name: '选文件夹并开始' }))
      expect((await screen.findByTestId('library-export-done')).textContent).toContain('当前还有一轮处理没结束')
    })

    it('选文件夹时点了取消 → 什么都不提示', async () => {
      const notify = await setup([row(1)])
      pick('视频1')
      fireEvent.click(screen.getByRole('button', { name: '打包交付…' }))
      fireEvent.click(screen.getByRole('button', { name: '选文件夹并开始' }))
      await waitFor(() => expect(window.api.exportLibrary).toHaveBeenCalled())
      expect(notify).not.toHaveBeenCalled()
      expect(screen.queryByTestId('library-export-done')).toBeNull()
    })
  })
})
