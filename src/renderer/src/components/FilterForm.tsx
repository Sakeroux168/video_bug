import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { CreateTaskInput, Filters, TaskType } from '../../../shared/types'
import { btnPrimary, inputCls, Card } from './ui'

export default function FilterForm({ onSubmit }: { onSubmit: (t: CreateTaskInput) => void }) {
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string }>>([])
  const [platform, setPlatform] = useState('douyin')
  const [type, setType] = useState<TaskType>('keyword')
  const [query, setQuery] = useState('')
  const [timeRange, setTimeRange] = useState<Filters['timeRange']>('all')
  const [duration, setDuration] = useState<Filters['duration']>('all')
  const [target, setTarget] = useState(200)
  const [aiFilter, setAiFilter] = useState(false)
  const [aiRule, setAiRule] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { void api.listPlatforms().then(setPlatforms) }, [])

  const targetValid = target >= 200 && target <= 1000

  function submit(): void {
    if (!query.trim()) { setErr('请输入关键词/作者/话题'); return }
    if (!targetValid) { setErr('目标数量需在 200-1000 之间'); return }
    if (aiFilter && !aiRule.trim()) { setErr('开启先审后下需填写筛选规则'); return }
    setErr('')
    onSubmit({
      platform, type, query: query.trim(),
      filters: { timeRange, duration, targetCount: target, aiFilterRule: aiFilter ? aiRule.trim() : undefined },
      aiFilterEnabled: aiFilter, aiOrganizeEnabled: false
    })
    setQuery('')
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
            onChange={e => setTarget(Number(e.target.value))} min={200} max={1000} />
          {!targetValid && <span className="text-red-500">需在 200-1000</span>}
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
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </Card>
  )
}
