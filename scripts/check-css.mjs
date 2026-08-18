// scripts/check-css.mjs — 第四件套：确认关键 Tailwind 类真的进了打包产物
//
// 为什么需要它：Tailwind purge 掉动态拼接的类名时，测试全绿、typecheck 绿、build EXIT 0，
// **只有打包后的真实界面丢色**。而交付形态是绿色版直接发给员工，出问题时对方没有 DevTools。
//
// 为什么不能直接用 grep：CSS 里类名是转义过的——`py-0.5` 写作 `.py-0\.5`、
// `bg-brand-200/40` 写作 `.bg-brand-200\/40`、`text-[10px]` 写作 `.text-\[10px\]`。
// 用字面量 grep 会把存在的类误报成「被 purge 了」（本轮实际踩过一次）。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'out/renderer/assets'
const css = readdirSync(DIR).filter(f => f.endsWith('.css')).map(f => readFileSync(join(DIR, f), 'utf8')).join('\n')

/** 按 CSS 规则转义类名里的特殊字符，再判断是否存在 */
// 逐字符转义而不用正则：正则字符类里的 / 与 [ ] 自己又要转义，嵌两层极易写错（已错一次）
const ESC = String.fromCharCode(92)
const SPECIAL = '.:/[]'
const has = (cls) => {
  let sel = ''
  for (const ch of cls) sel += SPECIAL.includes(ch) ? ESC + ch : ch
  return css.includes('.' + sel)
}

const MUST = [
  // 设计令牌
  'bg-brand-600', 'text-brand-600', 'border-brand-600', 'bg-brand-50',
  // 带变体前缀的要写完整：产物里是 `.focus\:ring-brand-500:focus`，
  // 只写 'ring-brand-500' 会被误报成被 purge（实际踩过）
  'focus:ring-brand-500',
  'border-brand-400', 'bg-brand-200/40', 'bg-brand-50/40',
  'text-success-600', 'text-danger-600', 'text-danger-500', 'text-amber-600',
  'text-sky-600', 'bg-sky-500', 'bg-sky-50',
  'text-slate-500', 'text-slate-600', 'border-slate-200', 'border-slate-300', 'bg-slate-50',
  // 按钮尺寸（btn() 三档）
  'px-2', 'py-0.5', 'py-1', 'px-4', 'py-2', 'text-xs', 'text-sm',
  // 只失败态才用到的组合
  'border-danger-300', 'bg-danger-50', 'text-danger-600',
  // 细节
  'text-[10px]'
  // 注：'tabular-nums' 属于 P4（数值等宽对齐），那一步落地时再加进来
]
const GONE = ['text-zinc-500', 'bg-blue-50', 'text-blue-600', 'text-green-600', 'text-orange-500']

const missing = MUST.filter(c => !has(c))
const leftover = GONE.filter(c => has(c))

for (const c of missing) console.log('  ✗ 缺失（可能被 purge）:', c)
for (const c of leftover) console.log('  ✗ 旧类仍在产物里:', c)
if (missing.length === 0 && leftover.length === 0) console.log(`  ✓ ${MUST.length} 个关键类全部在产物中，${GONE.length} 个旧类已清除`)
process.exit(missing.length + leftover.length === 0 ? 0 : 1)
