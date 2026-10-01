import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { installFakeApi } from './helpers/fake-api'

// jsdom 环境（组件测试）专用 setup：
// - 引入 jest-dom 断言（toBeInTheDocument 等）
// - 预装假 api，替代 preload 注入的 window.api（node 环境的旧测试不受影响）
// - 每个测试后自动 unmount 组件树，避免 DOM 跨测试累积
// - 每个测试后清空 localStorage：界面会在本机记住一些偏好（如作者收藏上次选的平台 tab），不能串到下一个测试
installFakeApi()
afterEach(() => {
  cleanup()
  try { globalThis.localStorage?.clear() } catch { /* node 环境没有 localStorage */ }
})
