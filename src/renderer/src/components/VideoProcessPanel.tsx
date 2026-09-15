import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { ProcessItem, ProcessState } from '../../../shared/types'
import { Card, btn, inputCls } from './ui'

const EMPTY: ProcessState = {
  phase: 'idle', dir: null, total: 0, completed: 0, done: 0, skipped: 0, failed: 0,
  processing: 0, remaining: 0, current: null, items: [], log: []
}

/** 尺寸显示：拿不到就空着（探测失败 / 还没探测），不编一个数字出来 */
function size(v?: { width: number; height: number }): string {
  return v ? `${v.width}×${v.height}` : '—'
}

const ITEM_STATUS: Record<ProcessItem['status'], string> = {
  pending: '等待',
  processing: '处理中',
  done: '完成',
  skipped: '已符合，跳过',
  failed: '失败',
  stopped: '已停止'
}

/** 单文件状态色：只映射失败/进行中/完成三档，其余用默认灰（与任务表格的行首色条同一克制原则） */
const ITEM_STATUS_CLS: Record<ProcessItem['status'], string> = {
  pending: 'text-slate-400',
  processing: 'text-sky-600',
  done: 'text-success-600',
  skipped: 'text-slate-500',
  failed: 'text-danger-600',
  stopped: 'text-slate-400'
}

const PHASE_TEXT: Record<ProcessState['phase'], string> = {
  idle: '未开始',
  running: '处理中',
  paused: '已暂停：当前文件处理完后不再开始下一个',
  stopping: '正在停止：中止当前转码…',
  finished: '全部完成',
  stopped: '已停止'
}

/**
 * 「视频处理」页：把原来藏在设置里的「统一输出分辨率」拆成独立的手动批处理。
 * 状态全部来自主进程的 ProcessState 快照（挂载时拉一次 + 订阅推送），按钮只发指令不猜结果，
 * 所以界面显示的阶段永远和真实处理生命周期一致。第一版只做统一分辨率，不是综合编辑器。
 */
export default function VideoProcessPanel({ notify = () => {} }: { notify?: (text: string) => void }): React.ReactElement {
  const [s, setS] = useState<ProcessState>(EMPTY)
  const [dir, setDir] = useState('')

  useEffect(() => {
    void api.getProcessState().then(next => {
      setS(next)
      // 主进程上一轮的目录带回输入框：切走再切回来不用重选
      setDir(prev => prev || next.dir || '')
    })
    return api.onProcessState(setS)
  }, [])

  async function pickDir(): Promise<void> {
    const picked = await api.pickVideoDir()
    if (picked) setDir(picked)
  }

  async function start(): Promise<void> {
    const r = await api.processStart(dir.trim())
    if (!r.ok) notify(`无法开始：${r.error ?? '未知错误'}`)
  }

  const busy = s.phase === 'running' || s.phase === 'paused' || s.phase === 'stopping'
  const canStart = !busy && dir.trim() !== ''
  const progressPct = s.total > 0 ? Math.round(((s.completed + s.failed) / s.total) * 100) : 0

  return (
    <div className="max-w-5xl space-y-4 pb-6">
      <Card title="视频处理 · 统一分辨率">
        <p className="text-xs leading-5 text-slate-500">
          选一个文件夹，递归找出里面的 .mp4，批量统一成 <span className="font-medium text-slate-700">竖屏 1080×1920 / 横屏 1920×1080</span>：
          主体保持原比例完整装入，空余区域用同画面模糊背景填充；已经符合标准的文件直接跳过，不做无意义的重编码。
        </p>
        <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          <span className="font-medium text-slate-700">输出方式：</span>
          转码结果先写到同目录的隐藏临时文件，验证合格后才把原文件改名为
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">原文件名.original.mp4</code>
          备份，再把结果放回原文件名。失败或停止只清理临时文件，原视频一个字节都不会动；
          已经有 .original.mp4 备份的文件视为处理过，会跳过。
        </p>
        <div className="mt-3 flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            待处理文件夹
            <input className={inputCls} value={dir} disabled={busy} onChange={e => setDir(e.target.value)} placeholder="例如 D:\\抖音视频" />
          </label>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={btn('secondary', 'md')} disabled={busy} onClick={() => void pickDir()}>浏览…</button>
            <button type="button" className={btn('primary', 'md')} disabled={!canStart} onClick={() => void start()}>开始处理</button>
            {s.phase === 'paused'
              ? <button type="button" className={btn('secondary', 'md')} onClick={() => void api.processResume()}>继续</button>
              : <button type="button" className={btn('secondary', 'md')} disabled={s.phase !== 'running'} onClick={() => void api.processPause()}>暂停</button>}
            <button type="button" className={btn('danger', 'md')} disabled={s.phase !== 'running' && s.phase !== 'paused'} onClick={() => void api.processStop()}>停止</button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          暂停会等当前文件转完再停（FFmpeg 转码没有断点，中途掐断等于白做）；停止会立即中止当前转码并清理临时文件。
        </p>
      </Card>

      <Card title="进度">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <span data-testid="process-phase" className={`font-medium ${s.phase === 'running' ? 'text-sky-600' : s.phase === 'finished' ? 'text-success-600' : 'text-slate-600'}`}>
            {PHASE_TEXT[s.phase]}
          </span>
          {s.dir && <span className="truncate text-slate-400">{s.dir}</span>}
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
          <div className="h-full bg-sky-500" style={{ width: `${progressPct}%` }} />
        </div>
        <div data-testid="process-stats" className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          {([
            ['总数', s.total],
            ['已完成', s.completed],
            ['处理中', s.processing],
            ['失败', s.failed],
            ['剩余', s.remaining]
          ] as Array<[string, number]>).map(([label, value]) => (
            <div key={label} className="rounded-md border border-slate-200 px-3 py-2">
              <div className="text-slate-400">{label}</div>
              <div className="text-lg font-semibold tabular-nums text-slate-800">{value}</div>
              {label === '已完成' && <div className="text-[10px] text-slate-400">其中转码 {s.done}，跳过 {s.skipped}</div>}
            </div>
          ))}
        </div>
        {s.current && (
          <div data-testid="process-current" className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-sky-50 px-3 py-2 text-xs text-slate-600">
            <span className="text-slate-400">当前文件</span>
            <span data-current-name className="font-medium text-slate-800">{s.current.name}</span>
            <span className="tabular-nums">{size(s.current.source)} → {size(s.current.target)}</span>
          </div>
        )}
      </Card>

      {s.items.length > 0 && (
        <Card title={`文件（${s.items.length}）`}>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400">
                  <th className="py-2 pr-2 font-medium">文件名</th>
                  <th className="py-2 pr-2 font-medium">状态</th>
                  <th className="py-2 pr-2 font-medium">原始尺寸</th>
                  <th className="py-2 pr-2 font-medium">目标尺寸</th>
                  <th className="py-2 font-medium">错误</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map(item => (
                  <tr key={item.path} className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 font-medium text-slate-700">{item.name}</td>
                    <td className={`py-1.5 pr-2 ${ITEM_STATUS_CLS[item.status]}`}>{ITEM_STATUS[item.status]}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-slate-500">{size(item.source)}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-slate-500">{size(item.target)}</td>
                    <td className="py-1.5 text-danger-600">{item.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="运行日志">
        <div data-testid="process-log" className="max-h-40 overflow-auto font-mono text-[11px] leading-5 text-slate-600">
          {s.log.length === 0
            ? <span className="text-slate-400">（空）</span>
            : s.log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </Card>
    </div>
  )
}
