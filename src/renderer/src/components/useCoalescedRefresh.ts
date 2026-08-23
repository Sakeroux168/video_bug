import { useCallback, useEffect, useRef } from 'react'

/**
 * 事件风暴合并：窗口内的 N 次触发合并成「前沿 1 次 + 尾部 1 次」。
 *
 * 为什么需要：下载器每个视频至少 emit 3 次状态变更（pending/downloading/done），
 * 500 个视频的任务约 1500 次事件。TaskList 此前是**每个事件无条件全量重拉**
 * （listTasks + N 次 getTaskStats + 已展开任务的全部视频），而且每次都要把整个
 * 视频数组序列化过 contextBridge。概览页再挂一套订阅就是直接翻倍。
 *
 * 为什么要「前沿 + 尾部」而不是纯防抖：纯防抖在持续事件流里会一直推迟执行，
 * 界面看起来像卡住了；纯节流又会丢掉最后一次状态。前沿保证第一时间有反应，
 * 尾部保证最终状态一定被拿到。
 */
export function useCoalescedRefresh(fn: () => void, delay = 800): () => void {
  // 存最新的 fn：调用方通常传内联箭头函数，每次渲染都是新引用，
  // 不用 ref 存的话尾部执行时会调到过期闭包
  const fnRef = useRef(fn)
  fnRef.current = fn

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
    }
  }, [])

  return useCallback(() => {
    if (timer.current) { pending.current = true; return }  // 窗口内：只记账
    fnRef.current()                                        // 前沿：立即执行
    timer.current = setTimeout(() => {
      timer.current = null
      if (pending.current && alive.current) { pending.current = false; fnRef.current() }
      else pending.current = false
    }, delay)
  }, [delay])
}
