import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { btn, Card } from './ui'
import { Icon } from './icons'

/**
 * 内置浏览器页。
 *
 * 员工反馈：这里只能打开抖音窗口，打不开快手的。后果不只是"看不到"——
 * 各平台要各自扫码登录，而登录只能在对应平台的窗口里做。
 * 所以每个已注册平台给一个入口，页面文案也不再写死抖音。
 */
export default function BrowserPanel({ notify }: { notify?: (text: string) => void }) {
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string }>>([])

  useEffect(() => { void api.listPlatforms().then(setPlatforms) }, [])

  async function openFor(name: string, label: string): Promise<void> {
    const r = await api.openBrowserFor(name)
    // 任务运行中会被拒绝（切平台要销毁重建窗口，等于打断任务），把原因说清楚
    if (!r.ok) notify?.(r.error ?? `打开${label}窗口失败`)
    else notify?.(`已打开${label}窗口`)
  }

  return (
    <div className="max-w-4xl space-y-4 text-slate-600">
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="rounded-lg bg-sky-50 p-2 text-sky-600">
              <Icon name="browser" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-slate-800">平台浏览器在独立窗口中运行</h2>
              <p className="mt-1 text-sm text-slate-500">任务运行中窗口会自动显示；任务停止后，切换到此页面时也会自动显示，切换到其他页面时会自动隐藏。</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              data-action="show-browser"
              className={btn('primary', 'sm')}
              onClick={() => void api.showBrowser()}
            >
              重新显示窗口
            </button>
            <button
              type="button"
              className={btn('secondary', 'sm')}
              onClick={() => void api.openBrowserDevtools()}
            >
              打开调试控制台
            </button>
          </div>
        </div>
      </Card>

      <Card title="打开某个平台的窗口">
        <p className="mb-3 text-xs leading-5 text-slate-500">
          每个平台各有独立的登录状态，互不影响。要登录哪个平台，就打开哪个平台的窗口。
          任务运行中不能切换平台——切换会重建窗口，等于打断正在跑的任务。
        </p>
        <div className="flex flex-wrap gap-2">
          {platforms.map(p => (
            <button
              key={p.name}
              type="button"
              data-platform={p.name}
              className={btn('secondary', 'sm')}
              onClick={() => void openFor(p.name, p.displayName)}
            >
              打开{p.displayName}窗口
            </button>
          ))}
        </div>
      </Card>

      <Card title="首次登录（每个平台各一次）">
        <div className="grid gap-4 md:grid-cols-3">
          <div data-login-step className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">1</span>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">打开该平台窗口</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">用上方对应平台的按钮打开；进入本页时也会自动显示上次那个窗口。</p>
            </div>
          </div>
          <div data-login-step className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">2</span>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">扫码登录</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">用该平台的手机端扫码登录，不需要在工具中输入密码。</p>
            </div>
          </div>
          <div data-login-step className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">3</span>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">确认进入首页</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">看到该平台首页即表示成功，登录状态会自动保存，下次不用再登。</p>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-warning-50 p-4">
          <h3 className="text-sm font-semibold text-warning-700">遇到验证</h3>
          <p className="mt-1 text-xs leading-5 text-warning-700">出现滑块或扫码验证时，请在平台窗口手动完成，然后回到任务页继续。</p>
        </section>
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-800">找不到窗口</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">窗口被最小化或遮挡时，点击上方“重新显示窗口”即可找回。</p>
        </section>
      </div>
    </div>
  )
}
