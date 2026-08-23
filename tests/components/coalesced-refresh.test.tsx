import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCoalescedRefresh } from '../../src/renderer/src/components/useCoalescedRefresh'

// 下载器每个视频至少 emit 3 次状态（pending/downloading/done），500 个视频 ≈ 1500 次事件。
// 每次事件都全量重拉（listTasks + N 次 getTaskStats + 展开任务的全部视频）会把 IPC 打爆，
// 且每次要把整个视频数组序列化过 contextBridge。合并成「前沿执行一次 + 窗口内尾部补一次」。

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useCoalescedRefresh', () => {
  it('首次触发立即执行（前沿），让界面第一时间有反应', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useCoalescedRefresh(fn, 800))
    act(() => { result.current() })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('窗口内触发 50 次 → 合并成一次尾部执行（总共 2 次：前沿 + 尾部）', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useCoalescedRefresh(fn, 800))
    act(() => { for (let i = 0; i < 50; i++) result.current() })
    expect(fn).toHaveBeenCalledTimes(1)        // 只有前沿那次
    act(() => { vi.advanceTimersByTime(900) })
    expect(fn).toHaveBeenCalledTimes(2)        // 尾部补一次，拿到最终状态
  })

  it('窗口过后再次触发 → 重新走前沿', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useCoalescedRefresh(fn, 800))
    act(() => { result.current() })
    act(() => { vi.advanceTimersByTime(900) })
    const after = fn.mock.calls.length
    act(() => { result.current() })
    expect(fn.mock.calls.length).toBe(after + 1)
  })

  it('卸载后不再执行——防止 setState-after-unmount', () => {
    const fn = vi.fn()
    const { result, unmount } = renderHook(() => useCoalescedRefresh(fn, 800))
    act(() => { result.current(); result.current() })
    const before = fn.mock.calls.length
    unmount()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(fn).toHaveBeenCalledTimes(before)
  })

  it('总是调用最新的 fn（闭包不过期）', () => {
    const a = vi.fn(); const b = vi.fn()
    const { result, rerender } = renderHook(({ f }) => useCoalescedRefresh(f, 800), { initialProps: { f: a } })
    act(() => { result.current() })
    rerender({ f: b })
    act(() => { result.current() })
    act(() => { vi.advanceTimersByTime(900) })
    expect(b).toHaveBeenCalled()
  })
})
