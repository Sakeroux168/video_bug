import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// vite-node 2.1.9 的 isNodeBuiltin 无法识别 node:sqlite（prefixedBuiltins 只有 node:test），
// 会把 node:sqlite 当普通模块解析而报 "Failed to load url sqlite"。
// 这里把 node:sqlite/sqlite 统一映射到 tests/helpers/node-sqlite.cjs（module.exports = require('node:sqlite')），
// 并将该文件加入外部依赖，交给 Node 原生加载。
export default defineConfig({
  plugins: [
    {
      name: 'node-sqlite-shim',
      resolveId(id) {
        if (id === 'node:sqlite' || id === 'sqlite') {
          return { id: resolve(process.cwd(), 'tests/helpers/node-sqlite.cjs') }
        }
      }
    }
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    server: { deps: { external: [/node-sqlite\.cjs$/] } }
  }
})
