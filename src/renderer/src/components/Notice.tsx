import { useEffect, useRef, useState } from 'react'

/**
 * 提示分级（2026-10-06 界面检查 D5）：以前成功和失败长一个样、都停 3 秒，
 * 「无法开始：文件夹不存在」和「链接已复制」看起来一模一样，错误一眨眼就没了。
 */
export type NoticeKind = 'success' | 'info' | 'warn' | 'error'

export interface NoticeOptions {
  duration?: number
  action?: { label: string; onClick: () => void | Promise<void> }
  /** 不传就按文字猜（inferNoticeKind） */
  kind?: NoticeKind
}
export type Notify = (text: string, options?: NoticeOptions) => void
interface NoticeState extends NoticeOptions { text: string; kind: NoticeKind; onClose?: () => void }

/** 各种提示停多久；错误不自动消失，要用户自己点 × 关掉 */
const DURATION: Record<NoticeKind, number | null> = { success: 3000, info: 4000, warn: 6000, error: null }

/** 调用方没说种类时按文字猜：几十处调用不用一个个改，新代码要明确的就传 kind */
export function inferNoticeKind(text: string): NoticeKind {
  if (/失败|无法|出错|错误|不存在|不能|没能|异常/.test(text)) return 'error'
  if (/^(已|成功)/.test(text.trim())) return 'success'
  return 'info'
}

export function useNotice(): { notice: NoticeState | null; notify: Notify } {
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const notify: Notify = (text, options = {}) => {
    const kind = options.kind ?? inferNoticeKind(text)
    const close = (): void => { if (timer.current) clearTimeout(timer.current); setNotice(null) }
    setNotice({ text, ...options, kind, onClose: close })
    if (timer.current) clearTimeout(timer.current)
    const ms = options.duration ?? DURATION[kind]
    timer.current = ms === null ? null : setTimeout(() => setNotice(null), ms)
  }
  return { notice, notify }
}

const STYLE: Record<NoticeKind, { box: string; icon: string }> = {
  success: { box: 'border-success-200 bg-white text-slate-800', icon: '✓' },
  info: { box: 'border-sky-200 bg-white text-slate-800', icon: 'ⓘ' },
  warn: { box: 'border-amber-300 bg-amber-50 text-amber-800', icon: '⚠' },
  error: { box: 'border-danger-300 bg-danger-50 text-danger-700', icon: '✕' }
}
const ICON_COLOR: Record<NoticeKind, string> = {
  success: 'text-success-600', info: 'text-sky-600', warn: 'text-amber-600', error: 'text-danger-600'
}

export function Notice({ notice }: { notice: NoticeState | null }): JSX.Element | null {
  if (!notice) return null
  const kind = notice.kind ?? 'info'
  const onClose = notice.onClose
  return <div
    role={kind === 'error' ? 'alert' : 'status'}
    data-kind={kind}
    className={`fixed right-4 top-14 z-50 flex max-w-[70vw] items-start gap-2 rounded-lg border px-4 py-2 text-sm shadow-lg ${STYLE[kind].box}`}
  >
    <span aria-hidden="true" className={`font-bold ${ICON_COLOR[kind]}`}>{STYLE[kind].icon}</span>
    <span className="break-words">{notice.text}</span>
    {notice.action && <button type="button" className="ml-1 whitespace-nowrap rounded border border-current px-2 py-0.5 text-xs hover:bg-black/5" onClick={() => void notice.action!.onClick()}>{notice.action.label}</button>}
    {kind === 'error' && onClose && <button type="button" aria-label="关闭" className="ml-1 leading-none opacity-70 hover:opacity-100" onClick={onClose}>×</button>}
  </div>
}
