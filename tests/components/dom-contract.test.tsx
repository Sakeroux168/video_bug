import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import App from '../../src/renderer/src/App'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// P0（round16）：把「硬约束」从注释升级成测试。
//
// 这些约束此前只靠代码注释和人记得，60 条组件测试一条都没覆盖，而 P3 视觉重构恰恰是
// 最可能违反它们的阶段——且违反后**不报错**，只是行为静默退化：
//   R2 框选容器与 <table> 之间插 wrapper → 遮罩坐标错位（jsdom 无布局，看不出来）
//   R3 filtered 行拿到 data-id     → 框选把已过滤行也选中，批量操作参数多出 id
//   R4 按钮不再是原生 button/a     → closest('button,a,input') 守卫失效，点行内按钮连带改选中态
//   R1 任务页改条件渲染            → 切 tab 回来输入被清空、进度订阅断开

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

function makeVideo(id: number, over: Partial<VideoRow> = {}): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title: `视频${id}`,
    author_id: null, play_addr: 'http://x/v.mp4', duration: 60,
    publish_time: '2026-08-01T00:00:00.000Z', stats: '{}', ai_verdict: null, ai_tags: null,
    status: 'done', local_path: 'D:/x/v.mp4', file_size: 1024, error: null, retry_count: 0,
    fetched_at: '2026-08-01T00:00:00.000Z', downloaded_at: null, author_nickname: '作者',
    ...over
  }
}

const stats: TaskStats = {
  total: 3, done: 2, failed: 0, downloading: 0, pending: 0, filtered: 1,
  collected: 0, cancelled: 0, paused: 0
}

/** 渲染 TaskList 并展开任务，返回框选容器 */
async function setup(videos: VideoRow[]): Promise<HTMLElement> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)
  render(<TaskList notify={() => {}} />)
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('标题')
  return screen.getByTestId('video-table')
}

function rowEl(c: HTMLElement, id: number): HTMLElement {
  return c.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement
}

/** 选中行 id（读 data-selected 属性，与视觉类名解耦） */
function selectedIds(c: HTMLElement): number[] {
  return Array.from(c.querySelectorAll('tbody tr[data-id]'))
    .filter(tr => tr.getAttribute('data-selected') === 'true')
    .map(tr => Number(tr.getAttribute('data-id')))
    .sort((a, b) => a - b)
}

/** 完整点击手势：mousedown 重置 didDrag → mouseup → click */
function clickRow(c: HTMLElement, id: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const el = rowEl(c, id)
  fireEvent.mouseDown(el, { clientX: 10, clientY: 10, ...mods })
  fireEvent.mouseUp(el, { clientX: 10, clientY: 10, ...mods })
  fireEvent.click(el, mods)
}

describe('DOM 契约：框选容器结构（R2）', () => {
  it('容器可由 data-testid 定位，且其直接子元素恰好是唯一的 <table>（中间不得插 wrapper）', async () => {
    const c = await setup([makeVideo(1), makeVideo(2)])
    expect(c.firstElementChild).not.toBeNull()
    expect(c.firstElementChild!.tagName).toBe('TABLE')
    expect(c.querySelectorAll(':scope > table').length).toBe(1)
  })
})

describe('DOM 契约：filtered 行不参与框选（R3）', () => {
  it('filtered 行没有 data-id，也没有 data-selected', async () => {
    const c = await setup([makeVideo(1), makeVideo(2, { status: 'filtered' })])
    const rows = Array.from(c.querySelectorAll('tbody tr'))
    const filtered = rows.find(r => (r.textContent ?? '').includes('视频2'))!
    expect(filtered.hasAttribute('data-id')).toBe(false)
    expect(filtered.hasAttribute('data-selected')).toBe(false)
  })
})

describe('DOM 契约：行内交互元素必须是原生 button/a（R4）', () => {
  it('点行内按钮不改变整行选中态——closest(button,a,input) 守卫生效', async () => {
    const c = await setup([makeVideo(1), makeVideo(2)])
    clickRow(c, 1)
    expect(selectedIds(c)).toEqual([1])

    // done 行提供「定位 / 原视频 / 删除」，逐个点过去，选中集合必须纹丝不动
    const row = rowEl(c, 1)
    const controls = Array.from(row.querySelectorAll('button, a'))
    expect(controls.length).toBeGreaterThan(0)
    for (const el of controls) {
      expect(['BUTTON', 'A']).toContain(el.tagName)
      fireEvent.mouseDown(el, { clientX: 10, clientY: 10 })
      fireEvent.mouseUp(el, { clientX: 10, clientY: 10 })
      fireEvent.click(el)
      expect(selectedIds(c)).toEqual([1])
    }
  })
})

describe('DOM 契约：任务页常驻挂载（R1）', () => {
  it('切到使用说明再切回，FilterForm 的输入仍在，且进度订阅未被退订', async () => {
    installFakeApi()
    const unsubscribe = vi.fn()
    vi.mocked(window.api.onTaskProgress).mockReturnValue(unsubscribe)
    render(<App />)

    const input = screen.getByPlaceholderText('输入内容') as HTMLInputElement
    fireEvent.change(input, { target: { value: '美食' } })
    expect(input.value).toBe('美食')

    fireEvent.click(screen.getByRole('button', { name: '使用说明' }))
    await waitFor(() => expect(document.body.textContent ?? '').toContain('扫码登录'))
    fireEvent.click(screen.getByRole('button', { name: '任务' }))

    // 被卸载重挂的话 value 会回到空串
    expect((screen.getByPlaceholderText('输入内容') as HTMLInputElement).value).toBe('美食')
    // 卸载会触发 effect cleanup → 退订
    expect(unsubscribe).not.toHaveBeenCalled()
  })
})
