import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings, AsrStatus, AsrProgress } from '../../../shared/types'
import { Card, btnPrimary, inputCls } from './ui'

/** 字节数格式化成可读体积 */
function fmtBytes(n: number): string {
  if (n < 0) return '—'
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`
  return `${n} B`
}

export default function SettingsPanel() {
  const [s, setS] = useState<AppSettings | null>(null)
  // 消息带上成败语义：此前成功与失败共用同一个绿色 span，
  // 「AI 连接失败：xxx」会被渲染成绿色，用户一眼看过去以为成功了。
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const ok = (text: string): void => setMsg({ text, kind: 'ok' })
  const err = (text: string): void => setMsg({ text, kind: 'err' })
  const [asr, setAsr] = useState<AsrStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<AsrProgress | null>(null)
  const [organizing, setOrganizing] = useState(false)

  async function refreshAsr(): Promise<void> { setAsr(await api.getAsrStatus()) }

  useEffect(() => {
    void api.getSettings().then(setS)
    void refreshAsr()
    // Task14：订阅 ASR 模型下载进度，画进度条；组件卸载时取消订阅
    const off = api.onAsrProgress(p => setProgress(p))
    return off
  }, [])

  if (!s) return <div className="text-sm text-slate-400">加载中…</div>

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS(prev => prev ? { ...prev, [k]: v } : prev)

  async function save(): Promise<void> {
    if (!s) return
    await api.saveSettings(s)
    ok('已保存')
    setTimeout(() => setMsg(null), 1500)
  }

  async function testAi(): Promise<void> {
    const r = await api.testAi()
    if (r.ok) ok('AI 连接正常'); else err(`AI 连接失败：${r.error}`)
  }

  async function downloadModels(): Promise<void> {
    setDownloading(true)
    setProgress(null)
    ok('模型下载中（约 230MB），请稍候…')
    try {
      const r = await api.downloadAsrModels()
      if (r.ok) ok('语音模型下载完成'); else err(`语音模型下载失败：${r.error}`)
    } catch (e) {
      err(`语音模型下载失败：${String(e)}`)
    } finally {
      setDownloading(false)
      setProgress(null)
      void refreshAsr()
    }
  }

  async function organizeAll(): Promise<void> {
    setOrganizing(true)
    try {
      const r = await api.organizeAll()
      if (r.ok) ok(`已整理 ${r.count} 个作者`); else err(`整理失败：${r.error}`)
    } finally { setOrganizing(false) }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card title="下载">
        <div className="flex items-end gap-2 text-xs text-slate-500">
          <label className="flex flex-1 flex-col gap-1">
            下载目录
            <input className={inputCls} value={s.downloadDir} onChange={e => set('downloadDir', e.target.value)} />
          </label>
          <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
            onClick={async () => { const dir = await api.pickDownloadDir(); if (dir) set('downloadDir', dir) }}>
            浏览…
          </button>
          <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
            onClick={() => void api.openDir(s.downloadDir)}>
            打开
          </button>
        </div>
      </Card>
      <Card title="AI 配置（OpenAI 兼容）">
        <div className="space-y-3 text-xs text-slate-500">
          <label className="flex flex-col gap-1">
            API 地址
            <input className={inputCls} value={s.aiBaseUrl} onChange={e => set('aiBaseUrl', e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="flex flex-col gap-1">
            API Key
            <input type="password" className={inputCls} value={s.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            模型
            <input className={inputCls} value={s.aiModel} onChange={e => set('aiModel', e.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <button className={btnPrimary} onClick={() => void testAi()}>测试连接</button>
        </div>
      </Card>
      <Card title="运行参数">
        <div className="grid grid-cols-3 gap-4 text-xs text-slate-500">
          <label className="flex flex-col gap-1">
            下载并发
            <input type="number" min={1} max={5} className={inputCls} value={s.downloadConcurrency} onChange={e => set('downloadConcurrency', Number(e.target.value))} />
          </label>
          {/* T2：滚动速度三档预设"每页最大等待秒数"初始值（慢8s/中5s/快3s）；数字微调直接生效 */}
          <label className="flex flex-col gap-1">
            滚动速度
            <select className={inputCls} value={s.scrollSpeed}
              onChange={e => {
                const speed = e.target.value as AppSettings['scrollSpeed']
                const preset = { slow: 8000, medium: 5000, fast: 3000 }[speed]
                setS(prev => prev ? { ...prev, scrollSpeed: speed, scrollPageWaitMs: preset } : prev)
              }}>
              <option value="slow">慢（8s）</option>
              <option value="medium">中（5s）</option>
              <option value="fast">快（3s）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            每页最大等待(秒)
            <input type="number" min={1} className={inputCls} value={s.scrollPageWaitMs / 1000}
              onChange={e => set('scrollPageWaitMs', Number(e.target.value) * 1000)} />
          </label>
          {/* R11 Task2：停滞检测阈值（默认 5 秒；爬取 5 秒无新视频即判爬不动，进入重搜自救循环） */}
          <label className="flex flex-col gap-1">
            停滞检测(秒)
            <input type="number" min={1} max={60} className={inputCls} value={s.stallThresholdSec}
              onChange={e => set('stallThresholdSec', Number(e.target.value))} />
          </label>
          {/* R12：重搜冷却(秒)——两次自动重搜的最小间隔（默认 10；停滞自救节流，机制在 scheduler 现读设置） */}
          <label className="flex flex-col gap-1">
            重搜冷却(秒)
            <input type="number" min={1} max={60} className={inputCls} value={s.rescueCooldownSec}
              onChange={e => set('rescueCooldownSec', Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            滚动间隔(ms)
            <input type="number" className={inputCls} value={s.scrollIntervalMs} onChange={e => set('scrollIntervalMs', Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            地址过期(分钟)
            <input type="number" className={inputCls} value={s.addressTtlMin} onChange={e => set('addressTtlMin', Number(e.target.value))} />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={s.allowDuplicateAuthor} onChange={e => set('allowDuplicateAuthor', e.target.checked)} />
          允许重复爬取已爬过主页的作者（取消勾选则自动去重跳过）
        </label>
        {/* Task14：语音模型状态 + 下载 + 整理全部 */}
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">语音模型（ASR）</span>
            <span className={asr?.ready ? 'text-emerald-600' : 'text-amber-600'}>
              {asr ? (asr.ready ? '已就绪' : '未就绪') : '查询中…'}
            </span>
          </div>
          {asr && (
            <div className="space-y-1">
              {asr.files.map(f => (
                <div key={f.key} className="flex items-center justify-between">
                  <span>{f.label}</span>
                  <span className={f.ok ? 'text-emerald-600' : 'text-slate-400'}>
                    {f.ok ? fmtBytes(f.actualBytes) : `未下载（${fmtBytes(f.expectBytes)}）`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button className={btnPrimary} disabled={downloading} onClick={() => void downloadModels()}>
              {downloading ? '下载中…' : '下载模型'}
            </button>
            <button
              className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 disabled:opacity-40"
              disabled={organizing}
              onClick={() => void organizeAll()}
            >
              {organizing ? '整理中…' : '整理全部'}
            </button>
          </div>
          {/* 下载进度条：onAsrProgress 实时推 received/total */}
          {downloading && progress && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="truncate">{progress.label}{progress.host ? `（${progress.host}）` : ''}</span>
                <span className="shrink-0">{fmtBytes(progress.received)} / {fmtBytes(progress.total)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
                <div
                  className="h-full bg-sky-500 transition-all"
                  style={{ width: `${progress.total > 0 ? (progress.received / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <button className={btnPrimary} onClick={() => void save()}>保存设置</button>
        {msg && <span className={`text-sm ${msg.kind === 'err' ? 'text-danger-600' : 'text-success-600'}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
