import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Notice, useNotice } from '../../src/renderer/src/components/Notice'

afterEach(() => vi.useRealTimers())
it('导出提示有文件名、可点定位按钮，停留 15 秒且避开顶部按钮', () => {
  vi.useFakeTimers()
  const open = vi.fn()
  function Harness() {
    const { notice, notify } = useNotice()
    return <><button onClick={() => notify('已导出 2 条 → 作者表.csv', { duration: 15000, action: { label: '打开所在文件夹', onClick: open } })}>导出</button><Notice notice={notice} /></>
  }
  render(<Harness />)
  fireEvent.click(screen.getByText('导出'))
  expect(screen.getByRole('status')).toHaveTextContent('已导出 2 条 → 作者表.csv')
  expect(screen.getByRole('status')).toHaveClass('top-14')
  fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }))
  expect(open).toHaveBeenCalledOnce()
  act(() => vi.advanceTimersByTime(3000))
  expect(screen.getByRole('status')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(12000))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
it('普通提示仍在 3 秒后消失，新提示取消上一条的计时器', () => {
  vi.useFakeTimers()
  function Harness() {
    const { notice, notify } = useNotice()
    return <><button onClick={() => notify('普通提示')}>通知</button><button onClick={() => notify('导出提示', { duration: 15000 })}>导出</button><Notice notice={notice} /></>
  }
  render(<Harness />)
  fireEvent.click(screen.getByText('通知'))
  act(() => vi.advanceTimersByTime(3000))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('通知'))
  act(() => vi.advanceTimersByTime(2000))
  fireEvent.click(screen.getByText('导出'))
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByRole('status')).toHaveTextContent('导出提示')
})
