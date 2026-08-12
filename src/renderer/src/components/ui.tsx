import React from 'react'

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ key: string; label: string }>; active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-slate-200 bg-white px-4">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`px-4 py-3 text-sm font-medium transition-colors ${active === t.key ? 'border-b-2 border-brand-600 text-brand-600' : 'text-slate-500 hover:text-slate-800'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {title && <h3 className="mb-3 text-sm font-semibold text-slate-700">{title}</h3>}
      {children}
    </div>
  )
}

export const inputCls = 'rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500'
export const btnPrimary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-40'

// ==========================
// 基元
// ==========================

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type BtnSize = 'sm' | 'md'

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-slate-300 text-slate-600 hover:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'text-danger-500 hover:bg-danger-50'
}
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-4 py-2 text-sm'
}

/**
 * 统一按钮基元，替掉全站 9 种手写按钮样式与 3 处 `!important` 覆盖。
 *
 * **必须渲染原生 `<button>` 且 children 原样透传**，这不是风格偏好而是功能依赖：
 * useMarqueeSelect 的 `closest('button, a, input')` 守卫靠标签名区分「点按钮」
 * 与「点行/框选」——换成 div/span 包装，点行内按钮会连带改变整行选中态；
 * 而 tasklist-batch-matrix 还有一条按 textContent 断言的按钮文案契约。
 */
export function Btn({
  variant = 'secondary', size = 'sm', action, className = '', children, ...rest
}: {
  variant?: BtnVariant
  size?: BtnSize
  /** 供测试断言「这一行提供了什么能力」，与按钮文案解耦 */
  action?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  return (
    <button
      {...rest}
      data-action={action}
      className={`rounded-md font-medium transition-colors disabled:opacity-40 ${BTN_VARIANT[variant]} ${BTN_SIZE[size]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * 框选容器基元，收敛此前被逐字复制 4 份的遮罩 div。
 *
 * **只渲染一层 div，直接子元素必须是唯一的 `<table>`**：框选遮罩用容器相对坐标，
 * 中间插任何 wrapper（哪怕只是加个圆角包边）都会让遮罩整体偏移。
 * 而 jsdom 没有布局引擎，这种错位任何渲染测试都发现不了——只能靠结构契约挡住。
 */
export function SelectContainer({
  testId, containerRef, marquee, onMouseDown, onMouseMove, endDrag, onClick, className = '', children
}: {
  testId: string
  containerRef: React.RefObject<HTMLDivElement>
  marquee: { left: number; top: number; width: number; height: number } | null
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  endDrag: () => void
  onClick: (e: React.MouseEvent) => void
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className={`relative select-none ${className}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={onClick}
    >
      {children}
      {marquee && (
        <div
          className="pointer-events-none absolute border border-brand-400 bg-brand-200/40"
          style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
        />
      )}
    </div>
  )
}

/** 空态：全站此前有 3 套写法（div 居中 / 裸 span / 塞进三元），统一到这里 */
export function EmptyState({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="py-8 text-center text-sm text-slate-400">{children}</div>
}

/** 加载态：同样收敛 3 套写法 */
export function LoadingState({ children = '加载中…' }: { children?: React.ReactNode }): React.ReactElement {
  return <div className="py-8 text-center text-sm text-slate-400">{children}</div>
}
