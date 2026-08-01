'use strict'

// vitest 2.1.9 自带的 vite-node 无法把 node:sqlite 当作 Node 内置模块（prefixedBuiltins 只有 node:test），
// 会把它当普通模块解析而报 "Failed to load url sqlite"。
// 通过 vitest.config.ts 的 resolveId 把 node:sqlite/sqlite 映射到这里，再按外部模块交给 Node 原生加载。
module.exports = require('node:sqlite')
