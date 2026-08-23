import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SideNav } from '../../src/renderer/src/components/ui'

// 侧边栏的**结构契约**。这些不是样式测试，是功能依赖：
//   · 导航项必须是原生 <button> —— 现有测试用 getByRole('button', {name}) 定位，
//     而且全站多处 closest('button, a, input') 守卫依赖真实标签名
//   · 可访问名必须严格等于文案 —— 加徽标数字会让它变成「使用说明 3」，
//     getByRole 是整串归一化匹配，直接挂。用 aria-label 把名字钉死
//   · 激活/非激活都要有 border-l-2 —— 条件性加边框会让整列横移 2px（同 ROW_BAR 教训）

const ITEMS = [
  { key: 'tasks', label: '任务', icon: 'tasks' as const },
  { key: 'help', label: '使用说明', icon: 'help' as const }
]

describe('SideNav 结构契约', () => {
  it('每个导航项都是原生 <button>', () => {
    const { container } = render(<SideNav items={ITEMS} active="tasks" onChange={() => {}} />)
    const btns = container.querySelectorAll('nav button')
    expect(btns.length).toBe(2)
    for (const b of btns) expect(b.tagName).toBe('BUTTON')
  })

  it('按文案能精确命中，且每个恰好一个', () => {
    render(<SideNav items={ITEMS} active="tasks" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '任务' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '使用说明' })).toBeTruthy()
  })

  // 这条现在会红：没有 aria-label 时徽标数字会污染可访问名
  it('带徽标后仍能按原文案命中（徽标不得污染可访问名）', () => {
    render(<SideNav items={[{ ...ITEMS[1], badge: 3 }]} active="tasks" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '使用说明' })).toBeTruthy()
  })

  it('激活项用 border-brand-600，非激活用 border-transparent；两者都有 border-l-2', () => {
    render(<SideNav items={ITEMS} active="tasks" onChange={() => {}} />)
    const active = screen.getByRole('button', { name: '任务' })
    const idle = screen.getByRole('button', { name: '使用说明' })
    expect(active.className).toContain('border-brand-600')
    expect(idle.className).toContain('border-transparent')
    expect(active.className).toContain('border-l-2')
    expect(idle.className).toContain('border-l-2')
  })

  it('aria-current="page" 只出现在激活项上', () => {
    render(<SideNav items={ITEMS} active="tasks" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '任务' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: '使用说明' }).getAttribute('aria-current')).toBeNull()
  })

  it('点击回调收到 key', () => {
    const onChange = vi.fn()
    render(<SideNav items={ITEMS} active="tasks" onChange={onChange} />)
    screen.getByRole('button', { name: '使用说明' }).click()
    expect(onChange).toHaveBeenCalledWith('help')
  })

  it('不给内容区加 transform 类——那会让框选遮罩画歪且 fixed toast 换包含块', () => {
    const { container } = render(<SideNav items={ITEMS} active="tasks" onChange={() => {}} />)
    expect(container.innerHTML).not.toMatch(/transition-all|translate-|scale-/)
  })
})
