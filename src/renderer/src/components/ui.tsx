import React from 'react'
import { Icon, type IconName } from './icons'

export interface NavItem {
  key: string
  label: string
  icon: IconName
  /** 可选徽标数字。**必须 aria-hidden**，否则可访问名会变成「使用说明 3」，
   *  而现有测试用 getByRole('button', { name: '使用说明' }) 整串匹配，会直接挂 */
  badge?: number
}

/**
 * 左侧导航。
 *
 * 三条硬约束（都是功能依赖，不是风格偏好）：
 *  1. **必须是原生 `<button>`** —— 现有测试靠 getByRole('button', {name}) 定位，
 *     且全站多处 `closest('button, a, input')` 守卫依赖真实标签名。
 *  2. **`aria-label` 把可访问名钉死**为 label —— aria-label 优先级高于内容，
 *     所以里面塞图标、塞徽标都不会污染它。这是比「徽标加 aria-hidden」更硬的保险。
 *  3. **激活与非激活都要 `border-l-2`**（非激活用 `border-transparent`）——
 *     条件性加边框会让整列在切换时横移 2px，同 TaskList 的 ROW_BAR 教训。
 *
 * 刻意用 `transition-colors` 而非 `transition-all`：后者会把将来任何 transform
 * 也纳入过渡，而 transform 会让框选遮罩画歪、让 fixed 定位的 toast 换包含块。
 * 同理**不做折叠动画** —— 桌面窗口折叠省不出有意义的空间，却是这两个坑唯一现实的触发场景。
 */
export function SideNav({ items, active, onChange }: {
  items: NavItem[]
  active: string
  onChange: (k: string) => void
}): React.ReactElement {
  return (
    <aside className="fixed left-0 top-0 z-30 flex h-screen w-56 flex-col border-r border-slate-200 bg-white">
      <div className="flex shrink-0 items-center gap-2 px-4 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
          <Icon name="download" className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold text-slate-800">视频爬取工具</span>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {items.map(it => {
          const on = active === it.key
          return (
            <button
              key={it.key}
              type="button"
              aria-label={it.label}
              aria-current={on ? 'page' : undefined}
              onClick={() => onChange(it.key)}
              className={`flex w-full items-center gap-2.5 rounded-r-md border-l-2 px-3 py-2 text-sm transition-colors ${
                on
                  ? 'border-brand-600 bg-brand-50 font-medium text-brand-600'
                  : 'border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
            >
              <Icon name={it.icon} className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{it.label}</span>
              {it.badge != null && it.badge > 0 && (
                <span aria-hidden="true" className="rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums text-slate-500">
                  {it.badge}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </aside>
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

const INPUT_BASE = 'rounded-md border border-slate-300 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500'
export const inputCls = `${INPUT_BASE} px-3 py-1.5 text-sm`
/** 小号输入框（表格内搜索框等）。此前靠 `${inputCls} !py-1 !text-xs` 覆盖——
 *  `!important` 的出现就是在说共享层缺一个 size 维度。 */
export const inputClsSm = `${INPUT_BASE} px-2 py-1 text-xs`
export const btnPrimary = 'whitespace-nowrap rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-40'
// 注：btnPrimary 等价于 btn('primary', 'md')，保留具名导出以免改动面过大

// ==========================
// 基元
// ==========================

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type BtnSize = 'xs' | 'sm' | 'md'

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-slate-300 text-slate-600 hover:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'text-danger-500 hover:bg-danger-50'
}
const BTN_SIZE: Record<BtnSize, string> = {
  xs: 'px-2 py-0.5 text-xs',
  sm: 'px-2 py-1 text-xs',
  md: 'px-4 py-2 text-sm'
}

const BTN_BASE = 'whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-40'

/**
 * 按钮类字符串（与 Btn 组件同一真源）。
 *
 * 全站曾有 9 种手写按钮写法 + 3 处 `!important` 覆盖共享类——
 * `!important` 的出现就是在说「共享层缺一个 size 维度」。
 * 这里把 variant × size 补齐，调用处只换 className 字符串，**不动任何元素**——
 * 因为 DOM 结构是框选与 28 条测试的命脉，不值得为了换个写法去动它。
 */
export const btn = (variant: BtnVariant = 'secondary', size: BtnSize = 'sm'): string =>
  `${BTN_BASE} ${BTN_VARIANT[variant]} ${BTN_SIZE[size]}`

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
      className={`${btn(variant, size)} ${className}`}
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
