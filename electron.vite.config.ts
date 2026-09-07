import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'asr-worker': resolve('src/main/asr/asr-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          platform: resolve('src/preload/platform.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    // 必须钉成 127.0.0.1：不配 host 时 Vite 绑 'localhost'，某些机器上它先解析到 ::1
    // 就只监听 IPv6，而 Electron/Chromium 加载 http://localhost:5173 走 IPv4 →
    // ERR_CONNECTION_REFUSED、窗口白屏。绑 IPv4 两边才对得上。
    server: { host: '127.0.0.1' },
    resolve: { alias: { '@': resolve('src/renderer/src') } }
  }
})
