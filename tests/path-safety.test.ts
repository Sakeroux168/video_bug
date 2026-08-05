import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'path'
import { isPathInside } from '../src/main/pathSafety'

// Task 3：video:delete 的路径穿越防护（path.relative 校验），抽成纯函数便于单测。
// 用 join 构造路径，保证 win32/posix 上断言一致。

const root = join(resolve(''), 'downloads')

describe('isPathInside（路径穿越防护）', () => {
  it('downloadDir 内直接文件/子目录文件为真', () => {
    expect(isPathInside(root, join(root, 'a.mp4'))).toBe(true)
    expect(isPathInside(root, join(root, '子目录', 'b.mp4'))).toBe(true)
    expect(isPathInside(root, join(root, 'deep', 'nested', 'c.mp4'))).toBe(true)
  })

  it('上一级目录（穿越）为假', () => {
    expect(isPathInside(root, join(root, '..', 'evil.mp4'))).toBe(false)
    expect(isPathInside(root, join(root, '..', '..', 'evil.mp4'))).toBe(false)
  })

  it('downloadDir 本身为假（不能删目录自身）', () => {
    expect(isPathInside(root, root)).toBe(false)
  })

  it('同级目录的兄弟路径为假', () => {
    const sibling = join(resolve(''), 'other', 'evil.mp4')
    expect(isPathInside(root, sibling)).toBe(false)
  })

  it('以 downloadDir 为前缀但不属于其下的路径为假（前缀陷阱）', () => {
    expect(isPathInside(root, join(root + '2', 'evil.mp4'))).toBe(false)
  })

  it('空串/根路径相对片段为假', () => {
    expect(isPathInside(root, '')).toBe(false)
  })

  it('win32：跨盘绝对路径为假', () => {
    if (process.platform !== 'win32') return
    expect(isPathInside('C:\\dl', 'D:\\evil.mp4')).toBe(false)
  })

  it('posix 语义：以斜杠分隔的穿越片段为假', () => {
    const posixRoot = '/base/dl'
    expect(isPathInside(posixRoot, '/base/dl/a.mp4')).toBe(true)
    expect(isPathInside(posixRoot, '/base/dl/../evil.mp4')).toBe(false)
    expect(isPathInside(posixRoot, `/base/dl/..${sep}evil.mp4`)).toBe(false)
  })
})
