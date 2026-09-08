import { describe, it, expect } from 'vitest'
import { safeFilename, ensureUniqueName, ensureUniqueStem } from '../src/main/filename'
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
  it('只用标题：不再拼作者名和作品 ID', () => {
    expect(safeFilename('标题', '作者', 'ABCDEFGHIJ')).toBe('标题')
  })

  it('剥掉标题自带的 #话题（抖音/快手的标题本来就是「正文 + 一串话题」）', () => {
    expect(safeFilename('父亲不顾一切 #二次元动漫 #重庆话配音 #动漫', '冉天棒', 'AW1'))
      .toBe('父亲不顾一切')
  })

  it('话题夹在中间也剥干净，多余空格收敛成一个', () => {
    expect(safeFilename('前半 #话题一 后半 #话题二', '作者', 'AW1')).toBe('前半 后半')
  })

  it('标题全是话题（实测 15% 是这样）→ 用话题词，去掉 # 号', () => {
    expect(safeFilename('#搞笑 #动物成精了', '作者', 'AW1')).toBe('搞笑 动物成精了')
  })

  it('标题为空且没有话题 → 回落作品 ID（此时没有任何可读信息，但仍要能反查原作品）', () => {
    expect(safeFilename('', '作者', '12345678')).toBe('12345678')
    expect(safeFilename('   ', '作者', '12345678')).toBe('12345678')
  })

  it('词中间的 # 不误伤（C#教程 不该被剥成 C）', () => {
    expect(safeFilename('C#教程 第一讲', '作者', 'AW1')).toBe('C#教程 第一讲')
  })

  it('剥完仍超 80 字符照常截断', () => {
    const long = '长'.repeat(100) + ' #话题'
    const name = safeFilename(long, '作者', 'AW1')
    expect(name.length).toBeLessThanOrEqual(80)
    expect(name).not.toContain('#')
  })

  it('话题里含 Windows 非法字符时，回落路径也要清洗', () => {
    expect(safeFilename('#a/b #c:d', '作者', 'AW1')).not.toMatch(/[\\/:*?"<>|]/)
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

describe('ensureUniqueStem', () => {
  it('视频或孤立封面占用名称时，为整对文件追加相同序号', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stem-'))
    const extensions = ['.mp4', '.jpg', '.png', '.webp']
    writeFileSync(join(dir, '标题.mp4'), 'old')
    expect(ensureUniqueStem(dir, '标题', extensions)).toBe('标题_1')
    rmSync(join(dir, '标题.mp4'))
    writeFileSync(join(dir, '标题.webp'), 'orphan')
    expect(ensureUniqueStem(dir, '标题', extensions)).toBe('标题_1')
    rmSync(dir, { recursive: true, force: true })
  })
})
