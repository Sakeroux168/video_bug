import React, { useEffect, useRef, useState } from 'react'
import { Tabs } from './components/ui'
import FilterForm from './components/FilterForm'
import TaskList from './components/TaskList'
import AuthorCollection from './components/AuthorCollection'
import BrowserPanel from './components/BrowserPanel'
import SettingsPanel from './components/SettingsPanel'
import { api } from './api'
import type { CreateTaskInput } from '../../shared/types'

export default function App(): JSX.Element {
  const [tab, setTab] = useState('panel')
  const [rawLog, setRawLog] = useState<Array<{ at: string; url: string; handled: boolean; stats?: { items: number; kept: number } }>>([])
  const [showLog, setShowLog] = useState(false)
  const [toast, setToast] = useState<{ text: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fix6: 固定右上角 toast，不随内容滚动消失
  function notify(text: string): void {
    setToast({ text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  async function startTask(input: CreateTaskInput): Promise<{ id: number | null; skipped: boolean; reason?: string }> {
    return api.createTask(input)
  }
  async function refreshLog(): Promise<void> {
    setRawLog(await api.getRawLog())
    setShowLog(true)
  }

  // 主进程主动通知（如触发验证暂停）→ 显示为固定 toast
  useEffect(() => {
    const off = api.onTaskNotice((e) => {
      const n = e as { text?: string } | null
      if (n?.text) notify(n.text)
    })
    return off
  }, [])

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2">
        <span className="text-base font-semibold">视频爬取工具</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100"
            onClick={() => void api.openBrowserDevtools()}
          >
            抖音调试控制台
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100"
            onClick={() => void refreshLog()}
          >
            查看拦截日志
          </button>
        </div>
      </header>
      <Tabs
        active={tab} onChange={k => {
          setTab(k)
          if (k === 'browser') void api.showBrowser()
          else void api.hideBrowser()
        }}
        tabs={[{ key: 'panel', label: '管理面板' }, { key: 'browser', label: '内置浏览器' }, { key: 'settings', label: '设置' }]}
      />
      {showLog && (
        <div className="border-b border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
            <span>主进程收到的接口拦截日志（{rawLog.length} 条，最新在后）</span>
            <button className="text-zinc-400 hover:text-zinc-600" onClick={() => setShowLog(false)}>收起</button>
          </div>
          <div className="max-h-40 overflow-auto font-mono text-[11px] leading-5">
            {rawLog.length === 0 && <span className="text-zinc-400">（空——主进程没收到任何 dy:raw 消息）</span>}
            {rawLog.map((r, i) => (
              <div key={i} className={r.handled ? 'text-emerald-700' : 'text-zinc-500'}>
                {r.at} {r.handled ? '[已处理]' : '[忽略] '}
                {r.stats ? `[解析${r.stats.items}→剩${r.stats.kept}] ` : ''}
                {r.url}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 固定右上角 toast：不随内容滚动，且在内置浏览器全屏（盖住面板）时也可见（位于顶部标题区） */}
      {toast && (
        <div className="pointer-events-none fixed right-4 top-2 z-50 max-w-[70vw] rounded-lg bg-zinc-800/90 px-4 py-2 text-sm text-white shadow-lg">
          {toast.text}
        </div>
      )}
      <main className="flex-1 overflow-auto p-4">
        {tab === 'panel' && (
          <div className="space-y-4">
            <FilterForm onSubmit={startTask} />
            <TaskList notify={notify} />
            <AuthorCollection notify={notify} />
          </div>
        )}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  )
}
