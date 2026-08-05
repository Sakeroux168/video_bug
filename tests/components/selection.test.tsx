import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 选择语义终版（需求 2026-08-02d ③）：点行排他 / ctrl 切换 / shift 范围（锚点）/
// 框选纯替换 / 点空白清空。逐条断言用户 6 步验收矩阵。

const ROW_H = 20 // 测试里每行 20px 高，用于框选几何模拟

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

function makeVideo(id: number): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title: `视频${id}`,
    author_id: null, play_addr: null, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
    stats: '{}', ai_verdict: null, ai_tags: null, status: 'collected', local_path: null,
    file_size: null, error: null, retry_count: 0, fetched_at: '2026-08-01T00:00:00.000Z',
    downloaded_at: null, author_nickname: '作者'
  }
}

const stats: TaskStats = {
  total: 7, done: 7, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 7, cancelled: 0, paused: 0
}

function makeVideos(n: number): VideoRow[] {
  return Array.from({ length: n }, (_, i) => makeVideo(i + 1))
}

/** 渲染 TaskList（1 个任务 + n 条视频）、展开任务、给容器与行 stub 几何矩形 */
async function setup(n: number): Promise<HTMLElement> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(stats)
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(makeVideos(n))

  render(<TaskList notify={() => {}} />)
  // 任务行与视频列表都是异步加载的，先等出现再点击/查询
  fireEvent.click(await screen.findByText('展开'))
  await screen.findByText('标题') // 视频表格头出现，视频已加载

  const containerDiv = screen.getByText('标题').closest('table')!.parentElement as HTMLElement
  // jsdom 的 getBoundingClientRect 全返回 0，框选相交判断需要真实几何：
  // 容器 600x400，第 i 个视频行（0 基）占据 y = i*20 .. i*20+20。
  // 注意不能对 'tbody tr' 全部 stub：视频表格位于外层任务表格的 tbody 内，
  // 它的 thead 行也会匹配 'tbody tr'（CSS 后代选择器只看祖先链），用 [data-id] 精确定位视频行。
  const cr = { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }
  ;(containerDiv as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => cr as DOMRect
  containerDiv.querySelectorAll('tbody tr[data-id]').forEach((tr, i) => {
    const y = i * ROW_H
    const r = { left: 0, top: y, right: 600, bottom: y + ROW_H, width: 600, height: ROW_H, x: 0, y, toJSON: () => ({}) }
    ;(tr as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r as DOMRect
  })
  return containerDiv
}

function rowEl(containerDiv: HTMLElement, id: number): HTMLElement {
  return containerDiv.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement
}

/** 当前选中（bg-blue-50）的行 id，升序 */
function selectedIds(containerDiv: HTMLElement): number[] {
  const ids = Array.from(containerDiv.querySelectorAll('tbody tr[data-id]'))
    .filter(tr => tr.classList.contains('bg-blue-50'))
    .map(tr => Number(tr.getAttribute('data-id')))
  return ids.sort((a, b) => a - b)
}

/** 模拟真实用户的完整点击手势：mousedown（重置 didDrag 防误伤标记）→ mouseup → click */
function clickRow(containerDiv: HTMLElement, id: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const el = rowEl(containerDiv, id)
  fireEvent.mouseDown(el, { clientX: 0, clientY: 0, ...mods })
  fireEvent.mouseUp(el, { clientX: 0, clientY: 0, ...mods })
  fireEvent.click(el, mods)
}

/** 框选：在容器内从 fromY 竖直拖到 toY（didDrag 判定 ≥5px，这里高度差 60px） */
function boxSelect(containerDiv: HTMLElement, fromY: number, toY: number): void {
  fireEvent.mouseDown(containerDiv, { clientX: 300, clientY: fromY })
  fireEvent.mouseMove(containerDiv, { clientX: 300, clientY: toY })
  fireEvent.mouseUp(containerDiv, { clientX: 300, clientY: toY })
}

describe('选择语义终版（视频表格）', () => {
  beforeEach(() => {
    installFakeApi()
  })

  it('用户 6 步矩阵：框选纯替换 / 点排他 / shift 范围 / ctrl 切换', async () => {
    const c = await setup(7)

    // ① 1/2/3 已选中 → 框选 2/3/4 → 只留 2/3/4（1 自动取消）
    clickRow(c, 1, { ctrlKey: true })
    clickRow(c, 2, { ctrlKey: true })
    clickRow(c, 3, { ctrlKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3])
    boxSelect(c, 20, 80) // 行 2/3/4（y 20..80）
    expect(selectedIds(c)).toEqual([2, 3, 4])

    // ② 再框选 5/6/7 → 只留 5/6/7（2/3/4 取消）
    boxSelect(c, 80, 140) // 行 5/6/7（y 80..140）
    expect(selectedIds(c)).toEqual([5, 6, 7])

    // ③ 点 1 → 只留 1
    clickRow(c, 1)
    expect(selectedIds(c)).toEqual([1])

    // ④ shift+点 4 → 选中 1~4（锚点为 1）
    clickRow(c, 4, { shiftKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3, 4])

    // ⑤ ctrl+点 5 → 新增 5（当前 1~5）
    clickRow(c, 5, { ctrlKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3, 4, 5])

    // ⑥ ctrl+点已选中的 2 → 去掉 2，其它保持
    clickRow(c, 2, { ctrlKey: true })
    expect(selectedIds(c)).toEqual([1, 3, 4, 5])
  })

  it('边界：点已选行清空 / ctrl 与框选不改锚点 / shift 无锚点退化', async () => {
    const c = await setup(7)

    // ctrl 选中 2/3（锚点仍为 null）
    clickRow(c, 2, { ctrlKey: true })
    clickRow(c, 3, { ctrlKey: true })
    // 无锚点时 shift 退化为普通排他点击
    clickRow(c, 5, { shiftKey: true })
    expect(selectedIds(c)).toEqual([5])

    // 点 1 → 锚点=1；再点已选中的 1 → 清空全部（排他语义）
    clickRow(c, 1)
    expect(selectedIds(c)).toEqual([1])
    clickRow(c, 1)
    expect(selectedIds(c)).toEqual([])

    // 点 1（锚点=1）→ shift+点 3 → 1~3，shift 点击后锚点=3
    clickRow(c, 1)
    clickRow(c, 3, { shiftKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3])

    // 点未选中的 5 → 只留 5，锚点=5；再点 1 → 只留 1，锚点=1
    clickRow(c, 5)
    expect(selectedIds(c)).toEqual([5])
    clickRow(c, 1)
    expect(selectedIds(c)).toEqual([1])

    // 框选 5/6（锚点仍是 1，框选不改锚点）→ shift+点 6 → 1~6 而非 5~6
    boxSelect(c, 80, 120)
    expect(selectedIds(c)).toEqual([5, 6])
    clickRow(c, 6, { shiftKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3, 4, 5, 6])

    // shift+点 6 后锚点=6；ctrl+点 4 切掉（锚点仍为 6）→ shift+点 2 → 范围 2..6
    // （若 ctrl 误改锚点为 4，则会是 2..4）
    clickRow(c, 4, { ctrlKey: true })
    expect(selectedIds(c)).toEqual([1, 2, 3, 5, 6])
    clickRow(c, 2, { shiftKey: true })
    expect(selectedIds(c)).toEqual([2, 3, 4, 5, 6])
  })
})
