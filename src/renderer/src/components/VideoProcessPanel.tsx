import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { ProcessItem, ProcessOptions, ProcessState } from '../../../shared/types'
import { Card, btn, inputCls } from './ui'

const EMPTY: ProcessState = {
  phase: 'idle', dir: null, total: 0, completed: 0, done: 0, skipped: 0, failed: 0,
  processing: 0, remaining: 0, current: null, items: [], log: []
}

/** 尺寸显示：拿不到就空着（探测失败 / 还没探测），不编一个数字出来 */
function size(v?: { width: number; height: number }): string {
  return v ? `${v.width}×${v.height}` : '—'
}

/** 文件大小：MB 一位小数；不知道就 — */
function mb(bytes?: number): string {
  return bytes === undefined ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
 * 「视频处理」页：把文件夹里的视频统一成竖屏 1080×1920 / 横屏 1920×1080。
 * 状态全部来自主进程的 ProcessState 快照（挂载时拉一次 + 订阅推送），按钮只发指令不猜结果，
 * 所以界面显示的阶段永远和真实处理生命周期一致。
 *
 * 2026-10-07：默认把结果放进「已处理」文件夹、原片不动；可选替换原文件、强制方向、严格 H.264；
 * initialDir：从文件管理「统一分辨率」跳过来时带的文件夹。
 */
// 和输入框有关的错误（文件夹不存在）就近显示在框下面，不再弹提示（界面 P3）；notify 参数留着兼容调用方
export default function VideoProcessPanel({ initialDir }: { notify?: (text: string) => void; initialDir?: string }): React.ReactElement {
  const [s, setS] = useState<ProcessState>(EMPTY)
  const [dir, setDir] = useState(initialDir ?? '')
  const [dirErr, setDirErr] = useState('')
  const [mode, setMode] = useState<NonNullable<ProcessOptions['mode']>>('folder')
  const [orientation, setOrientation] = useState<NonNullable<ProcessOptions['orientation']>>('auto')
  const [strict, setStrict] = useState(false)

  useEffect(() => {
    void api.getProcessState().then(next => {
      setS(next)
      // 主进程上一轮的目录带回输入框：切走再切回来不用重选（从别的页带着文件夹进来时以那个为准）
      setDir(prev => prev || next.dir || '')
    })
    return api.onProcessState(setS)
  }, [])
  useEffect(() => { if (initialDir) { setDir(initialDir); setDirErr('') } }, [initialDir])

  async function pickDir(): Promise<void> {
    const picked = await api.pickVideoDir()
    if (picked) { setDir(picked); setDirErr('') }
  }

  async function useDownloadDir(): Promise<void> {
    const settings = await api.getSettings()
    if (settings.downloadDir) { setDir(settings.downloadDir); setDirErr('') }
  }

  async function start(): Promise<void> {
    const r = await api.processStart(dir.trim(), { mode, orientation, strict })
    if (!r.ok) setDirErr(r.error ?? '无法开始')
  }

  const busy = s.phase === 'running' || s.phase === 'paused' || s.phase === 'stopping'
  const canStart = !busy && dir.trim() !== ''
  const progressPct = s.total > 0 ? Math.round(((s.completed + s.failed) / s.total) * 100) : 0
  const started = s.phase !== 'idle' || s.total > 0
  const finishedDir = s.outputDir ?? s.dir

  return (
    <div className="max-w-5xl space-y-4 pb-6">
      <Card title="视频处理 · 统一分辨率">
        <ul className="list-inside list-disc space-y-1 text-xs leading-5 text-slate-600">
          <li>把文件夹（含子文件夹）里的视频统一成 <span className="font-medium text-slate-700">竖屏 1080×1920 / 横屏 1920×1080</span>，画面完整装入，空余处用同画面的模糊背景填满。</li>
          <li>已经是这个尺寸、剪辑软件能直接打开的视频会跳过，不白白重转。</li>
          <li>转码时限制码率，体积一般不超过原片的 1.2 倍（原片本来就很糊、码率很低时会稍大一点，保证清晰）。</li>
        </ul>
        <details className="mt-1 text-xs text-slate-400">
          <summary className="cursor-pointer select-none">了解更多</summary>
          <p className="mt-1 leading-5">
            转码结果先写到隐藏的临时文件，检查合格后才放到最终位置；失败或停止只清理临时文件，原视频一个字节都不会动。
            选「替换原文件」时，原片会改名为 <code className="rounded bg-slate-100 px-1">原文件名.original.mp4</code> 留作备份，已经有这个备份的文件视为处理过，会跳过。
          </p>
        </details>

        <div className="mt-3 flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-start">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            待处理文件夹
            <input className={`${inputCls} ${dirErr ? 'border-danger-500 ring-1 ring-danger-200' : ''}`} value={dir} disabled={busy}
              aria-invalid={dirErr ? true : undefined}
              onChange={e => { setDir(e.target.value); setDirErr('') }} placeholder="例如 D:\抖音视频" />
            {dirErr && <span className="text-danger-600">{dirErr}</span>}
          </label>
          <div className="flex shrink-0 flex-wrap gap-2 sm:pt-5">
            <button type="button" className={btn('secondary', 'md')} disabled={busy} onClick={() => void pickDir()}>浏览…</button>
            <button type="button" className={btn('secondary', 'md')} disabled={busy} onClick={() => void useDownloadDir()}>用下载目录</button>
            <button type="button" className={btn('primary', 'md')} disabled={!canStart} onClick={() => void start()}>开始处理</button>
            {s.phase === 'paused'
              ? <button type="button" className={btn('secondary', 'md')} onClick={() => void api.processResume()}>继续</button>
              : <button type="button" className={btn('secondary', 'md')} disabled={s.phase !== 'running'} onClick={() => void api.processPause()}>暂停</button>}
            <button type="button" className={btn('danger', 'md')} disabled={s.phase !== 'running' && s.phase !== 'paused'} onClick={() => void api.processStop()}>停止</button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
          <span className="text-slate-400">结果放哪</span>
          <label className="flex items-center gap-1">
            <input type="radio" name="process-mode" checked={mode === 'folder'} disabled={busy} onChange={() => setMode('folder')} />
            放进这个文件夹下的「已处理」文件夹（原片不动）
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="process-mode" checked={mode === 'replace'} disabled={busy} onChange={() => setMode('replace')} />
            替换原文件（原片备份成 .original.mp4）
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
          <label htmlFor="process-orientation" className="flex items-center gap-2">
            <span className="text-slate-400">方向</span>
            <select id="process-orientation" className={inputCls} value={orientation} disabled={busy}
              onChange={e => setOrientation(e.target.value as NonNullable<ProcessOptions['orientation']>)}>
              <option value="auto">跟原片一样</option>
              <option value="portrait">全部转成竖屏</option>
              <option value="landscape">全部转成横屏</option>
            </select>
          </label>
          <label className="flex items-center gap-1" title="编码、像素格式、容器全部是标准 H.264 才跳过；一般用不到">
            <input type="checkbox" checked={strict} disabled={busy} onChange={e => setStrict(e.target.checked)} />
            严格 H.264（只有老剪辑软件需要）
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          暂停：等当前这个视频处理完再停。停止：马上停，当前这个视频不保存。
        </p>
      </Card>

      <Card title="进度">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <span data-testid="process-phase" className={`font-medium ${s.phase === 'running' ? 'text-sky-600' : s.phase === 'finished' ? 'text-success-600' : 'text-slate-600'}`}>
            {PHASE_TEXT[s.phase]}
          </span>
          {s.dir && <span className="truncate text-slate-400">{s.dir}</span>}
        </div>
        {s.phase === 'finished' && s.total > 0 && (
          <div data-testid="process-finished" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-success-200 bg-success-50 px-3 py-2 text-xs text-success-700">
            <span>处理完成：转码 {s.done}、跳过 {s.skipped}、失败 {s.failed}</span>
            {finishedDir && (
              <button type="button" className="font-medium underline" onClick={() => void api.openDir(finishedDir)}>打开文件夹</button>
            )}
          </div>
        )}
        {!started ? (
          <p className="text-xs text-slate-400">选好文件夹后点「开始处理」。</p>
        ) : (
          <>
            <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
              <div className={`h-full ${s.phase === 'finished' ? 'bg-success-500' : 'bg-sky-500'}`} style={{ width: `${progressPct}%` }} />
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
          </>
        )}
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
                  <th className="py-2 pr-2 font-medium">大小</th>
                  <th className="py-2 font-medium">错误</th>
                </tr>
              </thead>
              <tbody>
                {s.items.map(item => {
                  const bigger = item.sizeBefore !== undefined && item.sizeAfter !== undefined && item.sizeAfter > item.sizeBefore
                  return (
                    <tr key={item.path} className="border-b border-slate-100">
                      <td className="py-1.5 pr-2 font-medium text-slate-700">{item.name}</td>
                      <td className={`py-1.5 pr-2 ${ITEM_STATUS_CLS[item.status]}`}>{ITEM_STATUS[item.status]}</td>
                      <td className="py-1.5 pr-2 tabular-nums text-slate-500">{size(item.source)}</td>
                      <td className="py-1.5 pr-2 tabular-nums text-slate-500">{size(item.target)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-slate-500">
                        {item.sizeAfter !== undefined
                          ? <span {...(bigger ? { 'data-bigger': true } : {})} className={bigger ? 'text-amber-600' : undefined} title={bigger ? '处理后比原片大' : undefined}>
                              {mb(item.sizeBefore)} → {mb(item.sizeAfter)}
                            </span>
                          : mb(item.sizeBefore)}
                      </td>
                      <td className="py-1.5 text-danger-600">{item.error ?? ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="运行日志">
        <details open={busy}>
          <summary className="cursor-pointer select-none text-xs text-slate-400">展开 / 收起</summary>
          <div data-testid="process-log" className="mt-1 max-h-40 overflow-auto font-mono text-[11px] leading-5 text-slate-600">
            {s.log.length === 0
              ? <span className="text-slate-400">（空）</span>
              : s.log.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </details>
      </Card>
    </div>
  )
}
