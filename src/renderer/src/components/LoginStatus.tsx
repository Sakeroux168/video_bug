import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { PlatformLoginStatus } from '../../../shared/types'

const initial: PlatformLoginStatus[] = [
  { platform: 'douyin', displayName: '抖音', status: 'unknown' },
  { platform: 'kuaishou', displayName: '快手', status: 'unknown' },
  { platform: 'xiaohongshu', displayName: '小红书', status: 'unknown' }
]
export function useLoginStatuses(): PlatformLoginStatus[] {
  const [statuses, setStatuses] = useState(initial)
  useEffect(() => {
    let active = true
    let querying = false
    const refresh = async (): Promise<void> => {
      if (querying) return
      querying = true
      try {
        const values = await api.getLoginStatuses()
        if (active) setStatuses(initial.map(p => values.find(v => v.platform === p.platform) ?? p))
      } catch { if (active) setStatuses(initial) }
      finally { querying = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    window.addEventListener('focus', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  return statuses
}

// D6：「未知」改说「未确认」（以前任务行写「没登录」、状态灯写「未知」，两边打架），
// 没登录 / 没确认时旁边直接给去处理的按钮，打开这个平台的窗口
export function LoginStatusLight({ value }: { value: PlatformLoginStatus }): React.ReactElement {
  const label = { logged_in: '已登录', logged_out: '未登录', unknown: '未确认' }[value.status]
  const color = { logged_in: 'bg-success-600', logged_out: 'bg-amber-600', unknown: 'bg-slate-400' }[value.status]
  const action = value.status === 'logged_out' ? '去登录' : value.status === 'unknown' ? '检查' : null
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${color}`} />
    <span role="status">{value.displayName}：{label}</span>
    {action && <button type="button" className="text-brand-600 hover:underline" title={`打开${value.displayName}窗口`}
      onClick={() => { void api.openBrowserFor(value.platform).catch(() => {}) }}>{action}</button>}
  </span>
}

export default function LoginStatusLights(): React.ReactElement {
  const values = useLoginStatuses()
  return <div className="flex flex-wrap items-center gap-4">{values.map(v => <LoginStatusLight key={v.platform} value={v} />)}</div>
}
