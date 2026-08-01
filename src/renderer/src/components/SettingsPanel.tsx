import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings } from '../../../shared/types'
import { Card, btnPrimary, inputCls } from './ui'

export default function SettingsPanel() {
  const [s, setS] = useState<AppSettings | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => { void api.getSettings().then(setS) }, [])

  if (!s) return <div className="text-sm text-zinc-400">加载中…</div>

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS(prev => prev ? { ...prev, [k]: v } : prev)

  async function save(): Promise<void> {
    if (!s) return
    await api.saveSettings(s)
    setMsg('已保存')
    setTimeout(() => setMsg(''), 1500)
  }

  async function testAi(): Promise<void> {
    const r = await api.testAi()
    setMsg(r.ok ? 'AI 连接正常' : `AI 连接失败：${r.error}`)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card title="下载">
        <div className="flex items-end gap-2 text-xs text-zinc-500">
          <label className="flex flex-1 flex-col gap-1">
            下载目录
            <input className={inputCls} value={s.downloadDir} onChange={e => set('downloadDir', e.target.value)} />
          </label>
          <button type="button" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100"
            onClick={async () => { const dir = await api.pickDownloadDir(); if (dir) set('downloadDir', dir) }}>
            浏览…
          </button>
          <button type="button" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100"
            onClick={() => void api.openDir(s.downloadDir)}>
            打开
          </button>
        </div>
      </Card>
      <Card title="AI 配置（OpenAI 兼容）">
        <div className="space-y-3 text-xs text-zinc-500">
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
        <div className="grid grid-cols-3 gap-4 text-xs text-zinc-500">
          <label className="flex flex-col gap-1">
            下载并发
            <input type="number" min={1} max={5} className={inputCls} value={s.downloadConcurrency} onChange={e => set('downloadConcurrency', Number(e.target.value))} />
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
      </Card>
      <div className="flex items-center gap-3">
        <button className={btnPrimary} onClick={() => void save()}>保存设置</button>
        {msg && <span className="text-sm text-green-600">{msg}</span>}
      </div>
    </div>
  )
}
