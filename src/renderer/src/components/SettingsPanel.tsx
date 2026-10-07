import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings, AsrStatus, AsrProgress, AutomationStatus } from '../../../shared/types'
import { clampDownloadSegments, clampStuckTimeoutMin } from '../../../shared/types'
import { Card, btn, btnPrimary, inputCls } from './ui'

/** 字节数格式化成可读体积 */
function fmtBytes(n: number): string {
  if (n < 0) return '—'
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`
  return `${n} B`
}

/** 自动化：每个作者最多抓几条，1-200 */
function clampFollowCount(n: number): number {
  return Math.min(200, Math.max(1, Math.floor(Number(n) || 1)))
}

/** 上次追更的时间：10-07 09:00 */
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** onDirtyChange：有没有改了还没保存的内容（D3：App 据此在切页前提醒，以前切走改动就悄悄丢了） */
export default function SettingsPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [s, setS] = useState<AppSettings | null>(null)
  /** 最近一次从主进程读到 / 保存成功的设置（JSON），和当前输入框比较就知道改没改 */
  const [saved, setSaved] = useState<string | null>(null)
  const dirty = s !== null && saved !== null && JSON.stringify(s) !== saved
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  // 消息带上成败语义：此前成功与失败共用同一个绿色 span，
  // 「AI 连接失败：xxx」会被渲染成绿色，用户一眼看过去以为成功了。
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const ok = (text: string): void => setMsg({ text, kind: 'ok' })
  const err = (text: string): void => setMsg({ text, kind: 'err' })
  const [asr, setAsr] = useState<AsrStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<AsrProgress | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [auto, setAuto] = useState<AutomationStatus | null>(null)
  const [followMsg, setFollowMsg] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)

  async function refreshAuto(): Promise<void> {
    try { setAuto(await api.automationStatus()) } catch { setAuto(null) }
  }

  async function followNow(): Promise<void> {
    setFollowing(true)
    try {
      const r = await api.followNow()
      if (!r || r.authors === 0) setFollowMsg('还没有爬过主页的作者，先去「作者收藏」爬一次')
      else setFollowMsg(`已给 ${r.created} 个作者建了追更任务${r.skipped ? `（${r.skipped} 个已经在排队，跳过）` : ''}，去「任务」页看进度`)
      void refreshAuto()
    } catch {
      setFollowMsg('追更没建成，再试一次')
    } finally {
      setFollowing(false)
    }
  }

  async function refreshAsr(): Promise<void> { setAsr(await api.getAsrStatus()) }

  useEffect(() => {
    void api.getSettings().then(v => { setS(v); setSaved(JSON.stringify(v)) })
    void refreshAsr()
    void refreshAuto()
    // Task14：订阅 ASR 模型下载进度，画进度条；组件卸载时取消订阅
    const off = api.onAsrProgress(p => setProgress(p))
    return off
  }, [])

  if (!s) return <div className="text-sm text-slate-400">加载中…</div>

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS(prev => prev ? { ...prev, [k]: v } : prev)

  async function save(): Promise<void> {
    if (!s) return
    if (!Number.isFinite(s.asrMaxSec) || s.asrMaxSec < 10) {
      err('语音分析时长不能少于 10 秒')
      return
    }
    if (!Number.isFinite(s.organizeDebounceMs) || s.organizeDebounceMs < 0) {
      err('自动归档延迟不能小于 0 秒')
      return
    }
    // R20 复查：卡住判定只收 2-60 分钟（空、0、1 以前会被悄悄收下）；夹紧后把实际值显示回输入框
    if (!/^\d{1,2}:\d{2}$/.test(s.autoFollowTime ?? '')) {
      err('追更时间要写成 09:00 这样')
      return
    }
    const stuck = clampStuckTimeoutMin(s.stuckTimeoutMin)
    const segments = clampDownloadSegments(s.downloadSegments)
    const followCount = clampFollowCount(s.autoFollowCount)
    const toSave = stuck === s.stuckTimeoutMin && segments === s.downloadSegments && followCount === s.autoFollowCount
      ? s
      : { ...s, stuckTimeoutMin: stuck, downloadSegments: segments, autoFollowCount: followCount }
    if (toSave !== s) setS(toSave)
    await api.saveSettings(toSave)
    setSaved(JSON.stringify(toSave))
    void refreshAuto() // 「追更哪些作者」改了，会被追更的人数跟着变
    if (segments !== s.downloadSegments) ok(`已保存（分段数只能 1-4，已按 ${segments} 段保存）`)
    else ok(stuck === s.stuckTimeoutMin ? '已保存' : `已保存（卡住判定只能 2-60 分钟，已按 ${stuck} 分钟保存）`)
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
      if (!r.ok) err(`整理失败：${r.error}`)
      else if (r.skipped) ok('未开启任何分类层级，视频保持在下载目录里，无需整理')
      else ok(`已整理 ${r.count} 个作者`)
    } finally { setOrganizing(false) }
  }

  return (
    <div className="max-w-5xl space-y-4 pb-16">
      <div data-settings-grid className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="存储位置">
          <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              下载目录
              <input className={inputCls} value={s.downloadDir} onChange={e => set('downloadDir', e.target.value)} />
            </label>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                onClick={async () => { const dir = await api.pickDownloadDir(); if (dir) set('downloadDir', dir) }}>
                浏览…
              </button>
              <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                onClick={() => void api.openDir(s.downloadDir)}>
                打开
              </button>
            </div>
          </div>
        </Card>

        <Card title="下载与去重">
          <div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              下载并发
              <input type="number" min={1} max={5} className={inputCls} value={s.downloadConcurrency} onChange={e => set('downloadConcurrency', Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1">
              分段数
              <input aria-label="分段数" type="number" min={1} max={4} className={inputCls}
                value={Number.isFinite(s.downloadSegments) ? s.downloadSegments : ''}
                onChange={e => set('downloadSegments', e.target.value === '' ? Number.NaN : Number(e.target.value))} />
              <span className="text-slate-400">同一文件并行下载；1 表示关闭，最多 4 段</span>
            </label>
            <label className="flex flex-col gap-1">
              地址过期(分钟)
              <input type="number" min={1} className={inputCls} value={s.addressTtlMin} onChange={e => set('addressTtlMin', Number(e.target.value))} />
            </label>
          </div>
          <p className="mt-3 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-400">
            下载只保存平台给到的原视频，不再自动转码。需要统一成 1080p 的话，去左侧「视频处理」页选文件夹批量处理。
          </p>
          <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">下载后分文件夹整理</p>
            <p className="leading-5 text-slate-400">勾选的项会按「关键词 / 品类 / 作者 / 横竖屏 / 时长」的固定顺序建子文件夹；一项都不勾就直接放在下载目录里。</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.organizeByKeyword} onChange={e => set('organizeByKeyword', e.target.checked)} />
              <span>按关键词分文件夹</span>
            </label>
            <p className="pl-5 leading-5 text-slate-400">同一个关键词抓的视频放一起；抓达人主页的放「达人主页」。</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.organizeByCategory} onChange={e => set('organizeByCategory', e.target.checked)} />
              <span>按品类分文件夹</span>
            </label>
            <p className="pl-5 leading-5 text-slate-400">需要 AI 判断品类；不勾选就不会产生这部分调用。</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.organizeByAuthor} onChange={e => set('organizeByAuthor', e.target.checked)} />
              <span>按作者分文件夹</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.organizeByOrientation} onChange={e => set('organizeByOrientation', e.target.checked)} />
              <span>按横屏/竖屏分文件夹</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.organizeByDuration} onChange={e => set('organizeByDuration', e.target.checked)} />
              <span>按时长分文件夹</span>
            </label>
            {!s.organizeByKeyword && !s.organizeByCategory && !s.organizeByAuthor && !s.organizeByOrientation && !s.organizeByDuration && (
              <p className="leading-5 text-slate-500">当前：所有视频直接放在下载目录，不分文件夹。</p>
            )}
            <p className="leading-5 text-amber-600">改这里只影响之后下载的视频；已经归好的文件不会自动搬家。</p>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-600">
            <input className="mt-1" type="checkbox" checked={s.allowDuplicateAuthor} onChange={e => set('allowDuplicateAuthor', e.target.checked)} />
            允许重复爬取已爬过主页的作者（取消勾选则自动去重跳过）
          </label>
        </Card>

        <Card title="自动化">
          <div className="space-y-2 text-xs text-slate-500">
            <label className="flex items-start gap-2 leading-5 text-slate-600">
              <input className="mt-1" type="checkbox" checked={s.closeToTray} onChange={e => set('closeToTray', e.target.checked)} />
              关窗口时缩到右下角托盘，程序在后台继续跑
            </label>
            <label className="flex items-start gap-2 leading-5 text-slate-600">
              <input className="mt-1" type="checkbox" checked={s.notifyEnabled} onChange={e => set('notifyEnabled', e.target.checked)} />
              抓完、需要登录或验证时弹系统通知
            </label>
            <p className="pl-5 leading-5 text-slate-400">窗口在前台时不弹，界面里本来就有提示。</p>
            <div className="border-t border-slate-100 pt-2">
              <label className="flex items-start gap-2 leading-5 text-slate-600">
                <input className="mt-1" type="checkbox" checked={s.autoFollowEnabled} onChange={e => set('autoFollowEnabled', e.target.checked)} />
                每天定时追更
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-3 pl-5">
                <label className="flex items-center gap-2">
                  追更时间
                  <input type="time" className={`${inputCls} w-28`} value={s.autoFollowTime} onChange={e => set('autoFollowTime', e.target.value)} />
                </label>
                <label className="flex items-center gap-2">
                  每个作者最多抓
                  <input type="number" min={1} max={200} className={`${inputCls} w-20`} value={s.autoFollowCount}
                    onChange={e => set('autoFollowCount', Number(e.target.value))} />
                </label>
                <span>条</span>
                <label className="flex items-center gap-2">
                  追更哪些作者
                  <select className={inputCls} value={s.autoFollowScope ?? 'all'} onChange={e => set('autoFollowScope', e.target.value === 'picked' ? 'picked' : 'all')}>
                    <option value="all">全部爬过主页的作者</option>
                    <option value="picked">只追标了「定时追更」的作者</option>
                  </select>
                </label>
              </div>
              <p className="mt-1 pl-5 leading-5 text-slate-400">
                到点给要追的作者各建一个「只抓新视频」任务，排队一个个爬{auto ? `；现在有 ${auto.eligible} 个作者会被追更` : ''}。
                想只追其中几个：在「作者收藏」里勾上，点「加入定时追更」，再把上面改成「只追标了的」。
                错过了点（比如下午才开电脑），开程序后会补跑一次。
              </p>
              {s.autoFollowEnabled && !s.closeToTray && (
                <p className="mt-1 pl-5 leading-5 text-amber-600">关了窗口程序就退出了，到点也不会追更；建议同时勾上面的「缩到托盘」。</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
                <button type="button" className={btn('secondary', 'sm')} disabled={following} onClick={() => void followNow()}>现在追更一次</button>
                {auto?.lastResult && (
                  <span className="text-slate-400">
                    上次追更：{shortTime(auto.lastResult.at)}{auto.lastResult.manual ? '（手动）' : ''}，建了 {auto.lastResult.created} 个任务
                  </span>
                )}
              </div>
              {followMsg && <p className="mt-1 pl-5 leading-5 text-slate-600">{followMsg}</p>}
            </div>
          </div>
        </Card>

        <Card title="和百家号发布助手打通">
          <div className="space-y-2 text-xs text-slate-500">
            <label className="flex items-start gap-2 leading-5 text-slate-600">
              <input className="mt-1" type="checkbox" checked={s.bridgeEnabled !== false} onChange={e => set('bridgeEnabled', e.target.checked)} />
              开本机接口，让发布助手能让本程序去抓某个作者的主页（只在这台电脑内部，不对外）
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                端口
                <input type="number" min={1024} max={65535} className={`${inputCls} w-28`} value={s.bridgePort ?? 47321}
                  onChange={e => set('bridgePort', Number(e.target.value))} />
              </label>
              <span className="text-slate-400">发布助手 设置 → 发布 → 「爬取工具接口」要填一样的（默认 http://127.0.0.1:47321）；改了要重启本程序</span>
            </div>
            <p className="leading-5 text-slate-400">
              发布助手会把它按作者名对上达人后，把下到「品类\作者\」里的视频自动拉进各达人的暂存。作者文件夹名要和发布助手达人表里的达人名或站外昵称一样。
            </p>
          </div>
        </Card>

        <Card title="抓取参数">
          <div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
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
            <label className="flex flex-col gap-1">
              滚动间隔(ms)
              <input type="number" min={100} className={inputCls} value={s.scrollIntervalMs} onChange={e => set('scrollIntervalMs', Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1">
              停滞检测(秒)
              <input type="number" min={1} max={60} className={inputCls} value={s.stallThresholdSec}
                onChange={e => set('stallThresholdSec', Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1">
              重搜冷却(秒)
              <input type="number" min={1} max={60} className={inputCls} value={s.rescueCooldownSec}
                onChange={e => set('rescueCooldownSec', Number(e.target.value))} />
            </label>
            <label className="flex flex-col gap-1" title="任务这么多分钟没抓到新视频、页面也没在动，就当它卡住了：自动停下，让排队的下一个任务接着跑">
              卡住判定(分钟)
              <input type="number" min={2} max={60} className={inputCls} value={Number.isFinite(s.stuckTimeoutMin) ? s.stuckTimeoutMin : ''}
                onChange={e => set('stuckTimeoutMin', e.target.value === '' ? Number.NaN : Number(e.target.value))} />
            </label>
          </div>
        </Card>

        <Card title="AI 配置">
          <p className="mb-3 text-xs text-slate-400">支持 OpenAI 兼容接口，用于内容分析。</p>
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

        <Card title="语音模型">
          <div className="space-y-3 text-xs text-slate-500">
            <label className="flex flex-col gap-1">
              语音分析时长(秒)
              <input type="number" min={10} className={inputCls} value={s.asrMaxSec}
                onChange={e => set('asrMaxSec', Number(e.target.value))} />
            </label>
            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <span>模型状态</span>
              <span className={asr?.ready ? 'text-success-600' : 'text-warning-600'}>
                {asr ? (asr.ready ? '已就绪' : '未就绪') : '查询中…'}
              </span>
            </div>
            {asr && (
              <div className="space-y-1">
                {asr.files.map(f => (
                  <div key={f.key} className="flex items-center justify-between">
                    <span>{f.label}</span>
                    <span className={f.ok ? 'text-success-600' : 'text-slate-400'}>
                      {f.ok ? fmtBytes(f.actualBytes) : `未下载（${fmtBytes(f.expectBytes)}）`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button className={btnPrimary} disabled={downloading} onClick={() => void downloadModels()}>
              {downloading ? '下载中…' : '下载模型'}
            </button>
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

        <Card title="归档整理">
          <div className="space-y-3 text-xs text-slate-500">
            <p className="leading-5">下载完成后按作者自动归档；也可以手动整理已有文件。</p>
            <label className="flex flex-col gap-1">
              自动归档延迟(秒)
              <input type="number" min={0} className={inputCls} value={s.organizeDebounceMs / 1000}
                onChange={e => set('organizeDebounceMs', Number(e.target.value) * 1000)} />
            </label>
            <button
              className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 disabled:opacity-40"
              disabled={organizing}
              onClick={() => void organizeAll()}
            >
              {organizing ? '整理中…' : '整理全部'}
            </button>
          </div>
        </Card>
      </div>

      <div data-settings-actions className="sticky bottom-0 z-10 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
        {/* 圆点不算进按钮名字（aria-hidden），按钮始终叫「保存设置」 */}
        <button className={btnPrimary} title={dirty ? '有修改还没保存' : undefined} onClick={() => void save()}>
          保存设置{dirty && <span aria-hidden="true" data-testid="settings-dirty"> ●</span>}
        </button>
        {msg && <span className={`text-sm ${msg.kind === 'err' ? 'text-danger-600' : 'text-success-600'}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
