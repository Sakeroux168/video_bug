import React, { useEffect, useRef, useState } from 'react'
import { SideNav, btn, type NavItem } from './components/ui'
import Overview from './components/Overview'
import FilterForm from './components/FilterForm'
import TaskList from './components/TaskList'
import AuthorCollection from './components/AuthorCollection'
import FileManager from './components/FileManager'
import BrowserPanel from './components/BrowserPanel'
import SettingsPanel from './components/SettingsPanel'
import HelpPanel from './components/HelpPanel'
import { api } from './api'
import type { CreateTaskInput } from '../../shared/types'

/** 导航项。图标名来自 icons.tsx 的字面量 Record，写错名字 TS 会报。 */
const NAV: NavItem[] = [
  { key: 'overview', label: '概览', icon: 'overview' },
  { key: 'tasks', label: '任务', icon: 'tasks' },
  { key: 'authors', label: '作者收藏', icon: 'authors' },
  { key: 'files', label: '文件管理', icon: 'files' },
  { key: 'browser', label: '内置浏览器', icon: 'browser' },
  { key: 'settings', label: '设置', icon: 'settings' },
  { key: 'help', label: '使用说明', icon: 'help' }
]
const PAGE_TITLE: Record<string, string> = Object.fromEntries(NAV.map(n => [n.key, n.label]))

export default function App(): JSX.Element {
  // 默认落地页 = 概览。已核查：两个渲染 <App/> 的测试用 getByText/getByPlaceholderText，
  // 不过滤可见性，任务页 hidden 时元素仍在 DOM 且可点击，改默认不影响它们。
  const [tab, setTab] = useState('overview')

  // 拖音窗口显隐：由 tab **推导**，而不是散在每个点击回调里手动调。
  // 此前 Tabs.onChange 一处、引导条另手抄一处（因为它绕过 onChange 直接 setTab）——
  // 每新增一条程序化导航就要手抄一遍，漏抄不报错、不挂测试，
  // 只在真机表现为「切走了拖音窗口还挂着」。
  //
  // **刻意不写 cleanup**：main.tsx 有 StrictMode，加 cleanup 会让切到浏览器页变成
  // show→hide→show。无 cleanup 时挂载多发一次 hideBrowser 行为等价：
  // 主进程的 `taskRunning || forceBrowserFull` 分支会兜住恢复中的任务，
  // 而未曾 show 过的窗口 hide 是空操作。
  useEffect(() => {
    if (tab === 'browser') void api.showBrowser()
    else void api.hideBrowser()
  }, [tab])
  const [rawLog, setRawLog] = useState<Array<{
    at: string
    url?: string
    handled?: boolean
    stats?: { items: number; kept: number }
    durationZero?: boolean
    topKeys?: string[]
    filterLog?: string
  }>>([])
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
    <>
      {/* fixed 脱离文档流：**不是 main 的祖先**，所以高度链、min-h-0 陷阱、
          框选遮罩坐标系、fixed toast 的包含块全部不受影响——风险是被结构性消灭的，
          而不是靠「记得写 min-h-0」。z-30 < toast 的 z-50。 */}
      <SideNav items={NAV} active={tab} onChange={setTab} />

      {/* 除了 pl-56，根容器一字未改：flex h-screen flex-col 仍是全站唯一定高来源 */}
      <div className="flex h-screen flex-col bg-slate-50 pl-56 text-slate-800">
        {/* shrink-0：此前没有，只是因为 main 的 flex-basis 为 0 而恰好没触发 */}
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
          <span className="text-sm font-medium text-slate-700">{PAGE_TITLE[tab] ?? ''}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={btn('secondary', 'xs')}
            onClick={() => void api.openBrowserDevtools()}
          >
            抖音调试控制台
          </button>
          <button
            type="button"
            className={btn('secondary', 'xs')}
            onClick={() => void refreshLog()}
          >
            查看拦截日志
          </button>
        </div>
      </header>
      {showLog && (
        <div className="shrink-0 border-b border-slate-200 bg-slate-50 p-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
            <span>主进程收到的接口拦截 / 筛选日志（{rawLog.length} 条，最新在后）</span>
            <button className="text-slate-400 hover:text-slate-600" onClick={() => setShowLog(false)}>收起</button>
          </div>
          <div className="max-h-40 overflow-auto font-mono text-[11px] leading-5">
            {rawLog.length === 0 && <span className="text-slate-400">（空——还没有任何拦截/筛选日志）</span>}
            {rawLog.map((r, i) => (
              <div key={i} className={r.filterLog ? 'text-sky-700' : r.handled ? 'text-emerald-700' : 'text-slate-500'}>
                {r.at}{' '}
                {r.filterLog !== undefined ? (
                  <span>[筛选] {r.filterLog}</span>
                ) : (
                  <>
                    {r.handled ? '[已处理]' : '[忽略] '}
                    {r.stats ? `[解析${r.stats.items}→剩${r.stats.kept}] ` : ''}
                    {r.durationZero && (
                      <span className="text-amber-600">
                        [时长缺失{r.topKeys && r.topKeys.length > 0 ? ` 顶层字段:${r.topKeys.join(',')}` : ''}]&nbsp;
                      </span>
                    )}
                    {r.url}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 固定右上角 toast：不随内容滚动，且在内置浏览器全屏（盖住面板）时也可见（位于顶部标题区） */}
      {toast && (
        <div className="pointer-events-none fixed right-4 top-2 z-50 max-w-[70vw] rounded-lg bg-slate-800/90 px-4 py-2 text-sm text-white shadow-lg">
          {toast.text}
        </div>
      )}
      <main className="flex-1 overflow-auto p-4">
        {/* 任务页常驻挂载：切 tab 用 hidden 隐藏而非卸载，参数/展开状态/进度订阅保留 */}
        <div className={tab === 'tasks' ? 'space-y-4' : 'hidden'}>
          <button
            type="button"
            className="block text-xs text-slate-500 hover:text-slate-700 hover:underline"
            onClick={() => setTab('help')}
          >
            不知道怎么用？点左侧「使用说明」
          </button>
          <FilterForm onSubmit={startTask} />
          <TaskList notify={notify} />
        </div>
        {tab === 'overview' && <Overview onGoto={setTab} />}
        {tab === 'authors' && <AuthorCollection notify={notify} />}
        {tab === 'files' && <FileManager notify={notify} />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'help' && <HelpPanel />}
        </main>
      </div>
    </>
  )
}
