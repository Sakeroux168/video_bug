import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import FilterForm from '../../src/renderer/src/components/FilterForm'
import { LoginStatusLight } from '../../src/renderer/src/components/LoginStatus'
import { Notice, useNotice, inferNoticeKind } from '../../src/renderer/src/components/Notice'
import { installFakeApi } from '../helpers/fake-api'

// 2026-10-06 全面检查「界面」D4–D6：表单就近报错 + 回车提交 + 默认 20 条；提示分级；状态灯说法统一

afterEach(() => { vi.useRealTimers() })

describe('D4 新建抓取表单', () => {
  function setup() {
    installFakeApi()
    const onSubmit = vi.fn(async () => ({ id: 1, skipped: false }))
    render(<FilterForm onSubmit={onSubmit} />)
    return onSubmit
  }

  it('默认目标数量 20（和作者页「爬主页」一致）', () => {
    setup()
    expect(screen.getByLabelText(/目标数量/)).toHaveValue(20)
  })

  it('在关键词框里按回车就开始抓取', async () => {
    const onSubmit = setup()
    const input = screen.getByPlaceholderText('输入内容')
    fireEvent.change(input, { target: { value: '猫咪' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ query: '猫咪' })))
  })

  it('没填关键词：错误显示在关键词框下面、框标红；一输入就消失', async () => {
    const onSubmit = setup()
    fireEvent.click(screen.getByText('开始抓取'))
    const input = screen.getByPlaceholderText('输入内容')
    expect(await screen.findByText('请填写关键词')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.closest('label')).toHaveTextContent('请填写关键词')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '猫' } })
    expect(screen.queryByText('请填写关键词')).toBeNull()
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('刚选「自定义」时长、两个框都还空着时不先报红字', () => {
    setup()
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: 'custom' } })
    expect(screen.queryByText('自定义时长需为正整数，且最长秒数不能小于最短秒数')).toBeNull()
  })

  it('开了「AI 先审后下」没写规则：错误显示在规则框旁边', async () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText('输入内容'), { target: { value: '猫咪' } })
    fireEvent.click(screen.getByLabelText('AI 先审后下'))
    fireEvent.click(screen.getByText('开始抓取'))
    const rule = screen.getByPlaceholderText(/筛选规则/)
    expect(await screen.findByText('请填写筛选规则')).toBeInTheDocument()
    expect(rule).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('D5 提示分级', () => {
  it('按文字判断种类：失败 / 无法 / 出错 → 错误；已xx → 成功；其余 → 提示', () => {
    expect(inferNoticeKind('删除失败：文件被占用')).toBe('error')
    expect(inferNoticeKind('无法开始：文件夹不存在')).toBe('error')
    expect(inferNoticeKind('已复制链接')).toBe('success')
    expect(inferNoticeKind('已删除 2 个作者')).toBe('success')
    expect(inferNoticeKind('开始爬取「猫咪」')).toBe('info')
  })

  function Harness({ text, kind }: { text: string; kind?: 'success' | 'info' | 'warn' | 'error' }) {
    const { notice, notify } = useNotice()
    return <><button onClick={() => notify(text, kind ? { kind } : undefined)}>发</button><Notice notice={notice} /></>
  }

  it('错误提示：红色、一直显示，直到点 × 关掉', () => {
    vi.useFakeTimers()
    render(<Harness text="删除失败：文件被占用" />)
    fireEvent.click(screen.getByText('发'))
    const box = screen.getByRole('alert')
    expect(box).toHaveAttribute('data-kind', 'error')
    act(() => { vi.advanceTimersByTime(30000) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('成功提示：绿色，3 秒后自动消失', () => {
    vi.useFakeTimers()
    render(<Harness text="已保存" />)
    fireEvent.click(screen.getByText('发'))
    expect(screen.getByRole('status')).toHaveAttribute('data-kind', 'success')
    act(() => { vi.advanceTimersByTime(3100) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('调用方可以明确指定种类（警告停 6 秒）', () => {
    vi.useFakeTimers()
    render(<Harness text="没有建任务：已爬过" kind="warn" />)
    fireEvent.click(screen.getByText('发'))
    expect(screen.getByRole('status')).toHaveAttribute('data-kind', 'warn')
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(2100) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('D6 状态灯：「未知」改成「未确认」，旁边带去处理的按钮', () => {
  it('未确认 → 显示「检查」按钮，点了打开这个平台的窗口', () => {
    installFakeApi()
    render(<LoginStatusLight value={{ platform: 'kuaishou', displayName: '快手', status: 'unknown' }} />)
    expect(screen.getByText('快手：未确认')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查' }))
    expect(window.api.openBrowserFor).toHaveBeenCalledWith('kuaishou')
  })

  it('未登录 → 显示「去登录」；已登录 → 不显示按钮', () => {
    installFakeApi()
    const { rerender } = render(<LoginStatusLight value={{ platform: 'douyin', displayName: '抖音', status: 'logged_out' }} />)
    fireEvent.click(screen.getByRole('button', { name: '去登录' }))
    expect(window.api.openBrowserFor).toHaveBeenCalledWith('douyin')
    rerender(<LoginStatusLight value={{ platform: 'douyin', displayName: '抖音', status: 'logged_in' }} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
