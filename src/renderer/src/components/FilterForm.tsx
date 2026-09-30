import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { CreateTaskInput, Filters, TaskType } from '../../../shared/types'
import { btnPrimary, inputCls, Card } from './ui'

export default function FilterForm({ onSubmit }: { onSubmit: (t: CreateTaskInput) => Promise<{ id: number | null; skipped: boolean; reason?: string }> }) {
  // 只列已就绪的平台：接入中的平台解析器还没写，选了也跑不通
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string; authorInputPlaceholder: string; supportedTaskTypes?: readonly TaskType[] }>>([])
  const [platform, setPlatform] = useState('douyin')
  const [type, setType] = useState<TaskType>('keyword')
  const [query, setQuery] = useState('')
  const [timeRange, setTimeRange] = useState<Filters['timeRange']>('all')
  const [duration, setDuration] = useState<Filters['duration']>('all')
  const [durationMinSec, setDurationMinSec] = useState('')
  const [durationMaxSec, setDurationMaxSec] = useState('')
  const [target, setTarget] = useState(200)
  const [aiFilter, setAiFilter] = useState(false)
  const [aiRule, setAiRule] = useState('')
  const [aiOrganize, setAiOrganize] = useState(false)
  const [autoDownload, setAutoDownload] = useState(true)
  const [detailMode, setDetailMode] = useState<Filters['detailMode']>('safe')
  const [allowDuplicateAuthor, setAllowDuplicateAuthor] = useState<boolean | undefined>(undefined)
  const [err, setErr] = useState('')

  useEffect(() => {
    void api.listPlatforms().then(list => setPlatforms(list.filter(p => p.taskReady)))
    // 默认跟随全局设置：未在表单改过时 allowDuplicateAuthor 保持与设置一致
    void api.getSettings().then(s => setAllowDuplicateAuthor(s.allowDuplicateAuthor))
  }, [])

  // 作者输入提示跟随所选平台：选了快手还提示 douyin.com 的话，用户照着填必然失败。
  // 平台列表未到达时留空，不写死任何一个平台的 URL。
  const authorPlaceholder = platforms.find(p => p.name === platform)?.authorInputPlaceholder ?? ''
  const supportedTypes = platforms.find(p => p.name === platform)?.supportedTaskTypes ?? ['keyword', 'author', 'hashtag']
  useEffect(() => {
    if (!supportedTypes.includes(type)) setType('keyword')
  }, [platform, platforms, type])

  // 目标数量自由设置 1-1000（默认 200）
  const targetValid = target >= 1 && target <= 1000
  const customMin = Number(durationMinSec)
  const customMax = Number(durationMaxSec)
  const customDurationValid = duration !== 'custom' || (
    durationMinSec.trim() !== '' && durationMaxSec.trim() !== '' &&
    Number.isInteger(customMin) && Number.isInteger(customMax) &&
    customMin >= 1 && customMax >= customMin
  )

  async function submit(): Promise<void> {
    if (!query.trim()) { setErr('请输入关键词/作者/话题'); return }
    if (!targetValid) { setErr('目标数量需在 1-1000 之间'); return }
    if (!customDurationValid) { setErr('自定义时长需为正整数，且最长秒数不能小于最短秒数'); return }
    if (aiFilter && !aiRule.trim()) { setErr('开启先审后下需填写筛选规则'); return }
    setErr('')
    const r = await onSubmit({
      platform, type, query: query.trim(),
      filters: {
        timeRange, duration,
        durationMinSec: duration === 'custom' ? customMin : undefined,
        durationMaxSec: duration === 'custom' ? customMax : undefined,
        targetCount: target, aiFilterRule: aiFilter ? aiRule.trim() : undefined,
        detailMode: platform === 'xiaohongshu' ? detailMode : undefined
      },
      aiFilterEnabled: aiFilter, aiOrganizeEnabled: aiOrganize,
      autoDownload,
      allowDuplicateAuthor: type === 'author' ? allowDuplicateAuthor : undefined
    })
    if (r.skipped) setErr(r.reason ?? '已跳过：该作者已爬取过')
    else setQuery('')
  }
  return (
    <Card title="筛选条件">
      <div className="flex flex-wrap items-end gap-4">
        <label htmlFor="filter-platform" className="flex flex-col gap-1 text-xs text-slate-500">
          平台
          <select id="filter-platform" className={inputCls} value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 text-sm">
          {(['keyword', 'author', 'hashtag'] as const).filter(t => supportedTypes.includes(t)).map(t => (
            <label key={t} className="flex items-center gap-1">
              <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
              {t === 'keyword' ? '关键词' : t === 'author' ? '作者' : '话题'}
            </label>
          ))}
        </div>
        <label htmlFor="filter-query" className="flex flex-1 flex-col gap-1 text-xs text-slate-500 min-w-[200px]">
          {type === 'keyword' ? '关键词' : type === 'author' ? '作者主页链接或 ID' : '话题'}
          <input id="filter-query" className={inputCls} value={query} onChange={e => setQuery(e.target.value)} placeholder={type === 'author' ? authorPlaceholder : '输入内容'} />
        </label>
        <label htmlFor="filter-timerange" className="flex flex-col gap-1 text-xs text-slate-500">
          时间
          <select id="filter-timerange" className={inputCls} value={timeRange} onChange={e => setTimeRange(e.target.value as Filters['timeRange'])}>
            <option value="all">全部</option><option value="7d">近7天</option><option value="30d">近30天</option>
          </select>
        </label>
        <label htmlFor="filter-duration" className="flex flex-col gap-1 text-xs text-slate-500">
          时长
          <select id="filter-duration" className={inputCls} value={duration} onChange={e => setDuration(e.target.value as Filters['duration'])}>
            <option value="all">全部</option><option value="under30">30秒内（≤30秒）</option><option value="short">短(&lt;1分钟)</option><option value="medium">中(1-5分钟)</option><option value="long">长(&gt;5分钟)</option><option value="custom">自定义</option>
          </select>
        </label>
        {duration === 'custom' && (
          <>
            <label htmlFor="filter-duration-min" className="flex flex-col gap-1 text-xs text-slate-500">
              最短秒数
              <input id="filter-duration-min" type="number" min={1} step={1} className={`${inputCls} w-24`}
                value={durationMinSec} onChange={e => setDurationMinSec(e.target.value)} />
            </label>
            <label htmlFor="filter-duration-max" className="flex flex-col gap-1 text-xs text-slate-500">
              最长秒数
              <input id="filter-duration-max" type="number" min={1} step={1} className={`${inputCls} w-24`}
                value={durationMaxSec} onChange={e => setDurationMaxSec(e.target.value)} />
            </label>
          </>
        )}
        <label htmlFor="filter-target" className="flex flex-col gap-1 text-xs text-slate-500">
          目标数量
          <input id="filter-target" type="number" className={inputCls} value={target}
            onChange={e => setTarget(Number(e.target.value))} min={1} max={1000} />
          {!targetValid && <span className="text-red-500">需在 1-1000</span>}
        </label>
        <button className={btnPrimary} onClick={submit} disabled={!targetValid || !customDurationValid}>开始抓取</button>
      </div>
      {platform === 'xiaohongshu' && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
            <span className="text-xs text-slate-500">详情取数模式</span>
            <label className="flex items-center gap-1">
              <input type="radio" name="detailMode" checked={detailMode === 'safe'} onChange={() => setDetailMode('safe')} />
              稳妥
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="detailMode" checked={detailMode === 'fast'} onChange={() => setDetailMode('fast')} />
              快速
            </label>
            <span className="text-xs text-slate-500">快速模式更快，但更像程序访问。</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">小红书会先应用“视频”网页筛选，再逐条打开笔记获取下载地址；作者主页按卡片播放标识只收视频。近30天、自定义日期和时长会在详情阶段精确筛选，建议先试抓 3 条。</p>
        </>
      )}
      {duration === 'custom' && !customDurationValid && (
        <p className="mt-2 text-xs text-red-500">自定义时长需为正整数，且最长秒数不能小于最短秒数</p>
      )}
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
        <span className="text-xs text-slate-500">下载方式</span>
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
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </Card>
  )
}
