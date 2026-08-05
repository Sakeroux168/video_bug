import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { installFakeApi } from './helpers/fake-api'

// jsdom 环境（组件测试）专用 setup：
// - 引入 jest-dom 断言（toBeInTheDocument 等）
// - 预装假 api，替代 preload 注入的 window.api（node 环境的旧测试不受影响）
// - 每个测试后自动 unmount 组件树，避免 DOM 跨测试累积
installFakeApi()
afterEach(() => cleanup())
