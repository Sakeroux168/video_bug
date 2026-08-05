import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { CreateTaskInput, Filters, TaskType } from '../../../shared/types'
import { btnPrimary, inputCls, Card } from './ui'

export default function FilterForm({ onSubmit }: { onSubmit: (t: CreateTaskInput) => Promise<{ id: number | null; skipped: boolean; reason?: string }> }) {
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string }>>([])
  const [platform, setPlatform] = useState('douyin')
  const [type, setType] = useState<TaskType>('keyword')
  const [query, setQuery] = useState('')
  const [timeRange, setTimeRange] = useState<Filters['timeRange']>('all')
  const [duration, setDuration] = useState<Filters['duration']>('all')
  const [target, setTarget] = useState(200)
  const [aiFilter, setAiFilter] = useState(false)
  const [aiRule, setAiRule] = useState('')
  const [aiOrganize, setAiOrganize] = useState(false)
  const [autoDownload, setAutoDownload] = useState(true)
  // T3：搜索到底后用抖音筛选续爬（开关 + 4 个下拉，值=筛选面板选项索引，0=不限）
  const [dfEnabled, setDfEnabled] = useState(false)
  const [dfPublishTime, setDfPublishTime] = useState(0)
  const [dfDuration, setDfDuration] = useState(0)
  const [dfSearchScope, setDfSearchScope] = useState(0)
  const [dfContentType, setDfContentType] = useState(0)
  const [allowDuplicateAuthor, setAllowDuplicateAuthor] = useState<boolean | undefined>(undefined)
  const [err, setErr] = useState('')
  /** 测试筛选执行中：按钮置灰防重复点击（筛选流程约 3-5s，主进程另有互斥锁兜底） */
  const [testFilterBusy, setTestFilterBusy] = useState(false)
  /** 测试筛选结果：就地提示，成功绿色/失败红色 */
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void api.listPlatforms().then(setPlatforms)
    // 默认跟随全局设置：未在表单改过时 allowDuplicateAuthor 保持与设置一致
    void api.getSettings().then(s => setAllowDuplicateAuthor(s.allowDuplicateAuthor))
  }, [])

  // 目标数量自由设置 1-1000（默认 200）
  const targetValid = target >= 1 && target <= 1000

  async function submit(): Promise<void> {
    if (!query.trim()) { setErr('请输入关键词/作者/话题'); return }
    if (!targetValid) { setErr('目标数量需在 1-1000 之间'); return }
    if (aiFilter && !aiRule.trim()) { setErr('开启先审后下需填写筛选规则'); return }
    setErr('')
    const r = await onSubmit({
      platform, type, query: query.trim(),
      filters: {
        timeRange, duration, targetCount: target, aiFilterRule: aiFilter ? aiRule.trim() : undefined,
        // T3：开关关闭提交 undefined（不启用）；开启提交各下拉索引
        douyinFilter: dfEnabled
          ? { enabled: true, publishTime: dfPublishTime, duration: dfDuration, searchScope: dfSearchScope, contentType: dfContentType }
          : undefined
      },
      aiFilterEnabled: aiFilter, aiOrganizeEnabled: aiOrganize,
      autoDownload,
      allowDuplicateAuthor: type === 'author' ? allowDuplicateAuthor : undefined
    })
    if (r.skipped) setErr(r.reason ?? '已跳过：该作者已爬取过')
    else setQuery('')
  }
  /** 测试筛选（静默版）：对当前任务执行一次筛选流程，结果在配置区就地提示；
   *  与头部「手动测试筛选」诊断按钮功能相同，但 silent=true 不写拦截日志面板（平时用） */
  async function runTestFilter(): Promise<void> {
    if (testFilterBusy) return
    setTestFilterBusy(true)
    try {
      setTestResult(await api.testFilter(true))
    } finally {
      setTestFilterBusy(false)
    }
  }

  return (
    <Card title="筛选条件">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          平台
          <select className={inputCls} value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 text-sm">
          {(['keyword', 'author', 'hashtag'] as const).map(t => (
            <label key={t} className="flex items-center gap-1">
              <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
              {t === 'keyword' ? '关键词' : t === 'author' ? '作者' : '话题'}
            </label>
          ))}
        </div>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500 min-w-[200px]">
          {type === 'keyword' ? '关键词' : type === 'author' ? '作者主页链接或 ID' : '话题'}
          <input className={inputCls} value={query} onChange={e => setQuery(e.target.value)} placeholder={type === 'author' ? 'https://www.douyin.com/user/xxx' : '输入内容'} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          时间
          <select className={inputCls} value={timeRange} onChange={e => setTimeRange(e.target.value as Filters['timeRange'])}>
            <option value="all">全部</option><option value="7d">近7天</option><option value="30d">近30天</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          时长
          <select className={inputCls} value={duration} onChange={e => setDuration(e.target.value as Filters['duration'])}>
            <option value="all">全部</option><option value="short">短(&lt;1分钟)</option><option value="medium">中(1-5分钟)</option><option value="long">长(&gt;5分钟)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          目标数量
          <input type="number" className={inputCls} value={target}
            onChange={e => setTarget(Number(e.target.value))} min={1} max={1000} />
          {!targetValid && <span className="text-red-500">需在 1-1000</span>}
        </label>
        <button className={btnPrimary} onClick={submit} disabled={!targetValid}>开始抓取</button>
      </div>
      <div className="mt-3 flex items-center gap-6 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={aiFilter} onChange={e => setAiFilter(e.target.checked)} />
          AI 先审后下
        </label>
        {aiFilter && (
          <input className={`${inputCls} flex-1`} value={aiRule} onChange={e => setAiRule(e.target.value)}
            placeholder="筛选规则，如：只要美食教程，不要游戏直播" />
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={aiOrganize} onChange={e => setAiOrganize(e.target.checked)} />
          AI 下载后整理
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-6 text-sm">
        <span className="text-xs text-zinc-500">下载方式</span>
        <label className="flex items-center gap-1">
          <input type="radio" name="autoDownload" checked={autoDownload} onChange={() => setAutoDownload(true)} />
          自动下载
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="autoDownload" checked={!autoDownload} onChange={() => setAutoDownload(false)} />
          手动挑选
        </label>
        {type === 'author' && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={allowDuplicateAuthor ?? false}
              onChange={e => setAllowDuplicateAuthor(e.target.checked)} />
            允许重复爬取该作者主页（已爬过也继续）
          </label>
        )}
      </div>
      {/* T3：搜索到底后用抖音自带筛选续爬——停滞时自动点筛选面板，重置计数继续抓 */}
      <div className="mt-3 border-t border-zinc-100 pt-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={dfEnabled} onChange={e => setDfEnabled(e.target.checked)} />
          搜索到底后用抖音筛选续爬
        </label>
        {dfEnabled && (
          <>
          <div className="mt-2 flex flex-wrap items-end gap-4 text-xs text-zinc-500">
            <label className="flex flex-col gap-1">
              发布时间
              <select className={inputCls} value={dfPublishTime} onChange={e => setDfPublishTime(Number(e.target.value))}>
                <option value={0}>不限</option><option value={1}>一天内</option><option value={2}>一周内</option><option value={3}>半年内</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              视频时长
              <select className={inputCls} value={dfDuration} onChange={e => setDfDuration(Number(e.target.value))}>
                <option value={0}>不限</option><option value={1}>1分钟以下</option><option value={2}>1-5分钟</option><option value={3}>5分钟以上</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              搜索范围
              <select className={inputCls} value={dfSearchScope} onChange={e => setDfSearchScope(Number(e.target.value))}>
                <option value={0}>不限</option><option value={1}>关注的人</option><option value={2}>最近看过</option><option value={3}>还未看过</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              内容形式
              <select className={inputCls} value={dfContentType} onChange={e => setDfContentType(Number(e.target.value))}>
                <option value={0}>不限</option><option value={1}>视频</option><option value={2}>图文</option>
              </select>
            </label>
          </div>
          {/* T10③ 纠正版：头部诊断按钮保留，此处为静默版测试按钮（不写拦截日志），结果就地提示 */}
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={testFilterBusy}
              onClick={() => void runTestFilter()}
            >
              {testFilterBusy ? '筛选中...' : '测试筛选'}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? 'text-emerald-600' : 'text-red-500'}`}>{testResult.message}</span>
            )}
          </div>
          </>
        )}
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </Card>
  )
}
