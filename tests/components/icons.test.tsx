import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Icon, ICON_NAMES, type IconName } from '../../src/renderer/src/components/icons'

// 手写 inline SVG 而不引图标库的理由（记在这里，免得后人以为是没想过）：
//   · 交付形态是离线绿色版，多一个依赖就多一份打包体积与供应链面
//   · 用量只有 20 余个，图标库带来的是「每加一个图标多记一次 import」
//   · 图标库常见的 IconButton 封装会包 span/div —— 那正是 useMarqueeSelect 的
//     closest('button, a, input') 守卫最怕的东西，自己写就永远不会有这个诱惑
//
// PATHS 必须是完整字面量 Record（同 ROW_BAR 教训）：动态取名会让 TS 失去穷尽检查，
// 写错名字变成运行时静默不渲染。

describe('Icon', () => {
  it('每个图标名都渲染出 svg，且对无障碍隐藏、不进 tab 序列', () => {
    for (const name of ICON_NAMES) {
      const { container } = render(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg, `图标 ${name} 未渲染`).not.toBeNull()
      expect(svg!.getAttribute('aria-hidden')).toBe('true')
      expect(svg!.getAttribute('focusable')).toBe('false')
    }
  })

  it('className 原样透传（尺寸/颜色全靠调用方给）', () => {
    const { container } = render(<Icon name="tasks" className="h-4 w-4 shrink-0" />)
    expect((container.querySelector('svg') as SVGElement).getAttribute('class')).toContain('h-4 w-4')
  })

  it('颜色继承父元素（stroke=currentColor）——所以图标不引入任何新颜色类', () => {
    const { container } = render(<Icon name="tasks" />)
    expect((container.querySelector('svg') as SVGElement).getAttribute('stroke')).toBe('currentColor')
  })

  it('没有任何图标名映射到空内容（穷尽性）', () => {
    for (const name of ICON_NAMES) {
      const { container } = render(<Icon name={name as IconName} />)
      expect(container.querySelector('svg')!.childElementCount, `图标 ${name} 没有 path`).toBeGreaterThan(0)
    }
  })
})
