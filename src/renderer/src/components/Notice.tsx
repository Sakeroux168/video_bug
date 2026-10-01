import { useEffect, useRef, useState } from 'react'

export interface NoticeOptions {
  duration?: number
  action?: { label: string; onClick: () => void | Promise<void> }
}
export type Notify = (text: string, options?: NoticeOptions) => void
interface NoticeState extends NoticeOptions { text: string }

export function useNotice(): { notice: NoticeState | null; notify: Notify } {
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const notify: Notify = (text, options = {}) => {
    setNotice({ text, ...options })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNotice(null), options.duration ?? 3000)
  }
  return { notice, notify }
}

export function Notice({ notice }: { notice: NoticeState | null }): JSX.Element | null {
  if (!notice) return null
  return <div role="status" className="fixed right-4 top-14 z-50 max-w-[70vw] rounded-lg bg-slate-800/90 px-4 py-2 text-sm text-white shadow-lg">
    <span className="break-words">{notice.text}</span>
    {notice.action && <button type="button" className="ml-3 whitespace-nowrap rounded border border-white/50 px-2 py-1 text-xs hover:bg-white/20" onClick={() => void notice.action!.onClick()}>{notice.action.label}</button>}
  </div>
}
