import { describe, it, expect } from 'vitest'
import { safeFilename, ensureUniqueName } from '../src/main/filename'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('safeFilename', () => {
  it('替换 Windows 非法字符', () => {
    expect(safeFilename('a/b:c*d?e"f<g>h|i', '作者', '12345678')).toContain('_')
    expect(safeFilename('a/b', '作者', '12345678')).not.toMatch(/[\\/:*?"<>|]/)
  })
  it('超 80 截断', () => {
    const long = '长'.repeat(100)
    expect(safeFilename(long, '作者', '12345678').length).toBeLessThanOrEqual(80)
  })
  it('空标题兜底为 作者_id', () => {
    expect(safeFilename('', '作者', '12345678')).toBe('作者_12345678')
  })
  it('含标题+作者+id前8', () => {
    expect(safeFilename('标题', '作者', 'ABCDEFGHIJ')).toBe('标题_作者_ABCDEFGH')
  })
})

describe('ensureUniqueName', () => {
  it('冲突时追加序号', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fn-'))
    writeFileSync(join(dir, 'a.mp4'), '')
    expect(ensureUniqueName(dir, 'a.mp4')).toBe('a_1.mp4')
    rmSync(dir, { recursive: true, force: true })
  })
})
