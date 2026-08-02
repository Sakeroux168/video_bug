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
          douyin: resolve('src/preload/douyin.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@': resolve('src/renderer/src') } }
  }
})
