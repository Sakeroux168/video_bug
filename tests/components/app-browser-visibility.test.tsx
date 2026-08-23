import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from '../../src/renderer/src/App'
import { installFakeApi } from '../helpers/fake-api'

// 抖音窗口显隐是**跨进程状态机**，此前零测试覆盖。
//
// 红线澄清：交接文档说的「别手改 updateBrowserDisplay」指的是主进程 index.ts 里
// `taskRunning || forceBrowserFull` 压过用户 tab 选择的那段优先级逻辑——本轮一个字不动。
// 会被布局重构弄坏的是**渲染层「谁在什么时候调 showBrowser/hideBrowser」**：
// 调用点散在 Tabs.onChange 与引导条两处（引导条因为绕过 onChange 手抄了一份），
// 而 P2 要删掉 Tabs 和它的 onChange。先把这条逻辑锁进测试，重构才有安全网。
//
// **诚实边界**：这些断言锁的是「渲染层是否发出了正确的 IPC 调用」。
// 它证明不了抖音窗口真的显示/隐藏了——那段要真 Electron 环境才跑得起来。

const showCalls = (): number => vi.mocked(window.api.showBrowser).mock.calls.length
const hideCalls = (): number => vi.mocked(window.api.hideBrowser).mock.calls.length
const nav = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => { installFakeApi() })

describe('抖音窗口显隐：渲染层调用契约', () => {
  it('切到「内置浏览器」→ 调 showBrowser', () => {
    render(<App />)
    const before = showCalls()
    fireEvent.click(nav('内置浏览器'))
    expect(showCalls()).toBe(before + 1)
  })

  it('从浏览器页切到其它任意页 → 都要调 hideBrowser', () => {
    render(<App />)
    for (const label of ['任务', '作者收藏', '文件管理', '设置', '使用说明']) {
      fireEvent.click(nav('内置浏览器'))
      const before = hideCalls()
      fireEvent.click(nav(label))
      expect(hideCalls(), `切到「${label}」应调 hideBrowser`).toBe(before + 1)
    }
  })

  it('任务页引导条（绕过导航直接 setTab）→ 同样要调 hideBrowser', () => {
    render(<App />)
    fireEvent.click(nav('内置浏览器'))
    const before = hideCalls()
    fireEvent.click(screen.getByText(/不知道怎么用/))
    expect(hideCalls()).toBe(before + 1)
  })

  // 这条现在必红：onChange 写法每点一次就调一次，即使 tab 没变。
  // 它正是逼出「用 useEffect 依赖 tab」而不是「在点击回调里手动调」的那条测试。
  it('在同一页上重复点击导航 → 不重复发 IPC', () => {
    render(<App />)
    fireEvent.click(nav('内置浏览器'))
    const s = showCalls()
    const h = hideCalls()
    fireEvent.click(nav('内置浏览器'))
    fireEvent.click(nav('内置浏览器'))
    expect(showCalls()).toBe(s)
    expect(hideCalls()).toBe(h)
  })

  it('挂载后 hideBrowser 恰好 1 次（记录并接受这个行为：默认页不是浏览器页）', () => {
    render(<App />)
    expect(hideCalls()).toBe(1)
    expect(showCalls()).toBe(0)
  })
})
