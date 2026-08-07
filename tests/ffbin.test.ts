// tests/ffbin.test.ts — ffmpeg/ffprobe 可执行文件定位（纯逻辑，注入 fs 桩）
//
// 回归锁定：原实现用 spawnSync('where', ..., { encoding: 'utf8' }) 做 PATH 兜底，
// 中文 locale 的 Windows 上 where.exe 按 GBK(936) 输出，按 utf8 解码得到乱码路径 → ENOENT。
// 现改为直接扫 process.env.PATH（Node 已正确解码），不再 shell out。
import { describe, it, expect } from 'vitest'
import { findInRoots, findInPathEnv, resolveBin, defaultRoots, DEFAULT_ROOTS, type FfBinDeps } from '../src/main/ffbin'

/** 用一组存在的路径造 deps 桩；readdir 只对显式给出的目录有响应，其余抛（模拟盘符不存在） */
function makeDeps(files: string[], dirs: Record<string, string[]> = {}): FfBinDeps {
  const set = new Set(files.map(f => f.replace(/\\/g, '/')))
  return {
    exists: p => set.has(p.replace(/\\/g, '/')),
    readdir: p => {
      const key = p.replace(/\\/g, '/')
      if (!(key in dirs)) throw new Error('ENOENT')
      return dirs[key]
    }
  }
}

describe('findInPathEnv', () => {
  it('PATH 里的中文目录能命中（GBK 乱码回归）', () => {
    const dir = 'E:/视频爬取项目交接-v2/ffmpeg/bin'
    const deps = makeDeps([`${dir}/ffmpeg.exe`])
    expect(findInPathEnv('ffmpeg', `C:/Windows;${dir}`, deps.exists)).toBe(`${dir}/ffmpeg.exe`)
  })

  it('跳过空条目、去掉包裹的引号', () => {
    const dir = 'E:/123/ffmpeg-8.0.1/bin'
    const deps = makeDeps([`${dir}/ffprobe.exe`])
    expect(findInPathEnv('ffprobe', `;;"${dir}";C:/nope`, deps.exists)).toBe(`${dir}/ffprobe.exe`)
  })

  it('按 PATH 顺序取第一个命中的', () => {
    const a = 'C:/a/bin', b = 'C:/b/bin'
    const deps = makeDeps([`${a}/ffmpeg.exe`, `${b}/ffmpeg.exe`])
    expect(findInPathEnv('ffmpeg', `${b};${a}`, deps.exists)).toBe(`${b}/ffmpeg.exe`)
  })

  it('PATH 为空或全不命中 → null', () => {
    const deps = makeDeps([])
    expect(findInPathEnv('ffmpeg', undefined, deps.exists)).toBeNull()
    expect(findInPathEnv('ffmpeg', 'C:/nope;D:/nope', deps.exists)).toBeNull()
  })
})

describe('findInRoots', () => {
  it('盘符不存在（readdir 抛）不崩，继续扫下一个 root', () => {
    const deps = makeDeps(
      ['E:/123/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'],
      { 'E:/123': ['ffmpeg-8.0.1-essentials_build', 'ainame'] }
    )
    expect(findInRoots('ffmpeg', ['F:/123', 'E:/123'], deps))
      .toBe('E:/123/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe')
  })

  it('只认 ffmpeg 开头的目录', () => {
    const deps = makeDeps(
      ['E:/123/other/bin/ffmpeg.exe'],
      { 'E:/123': ['other'] }
    )
    expect(findInRoots('ffmpeg', ['E:/123'], deps)).toBeNull()
  })

  it('目录名匹配但 bin 下没有可执行文件 → null', () => {
    const deps = makeDeps([], { 'E:/123': ['ffmpeg-8.0.1'] })
    expect(findInRoots('ffprobe', ['E:/123'], deps)).toBeNull()
  })

  it('ffprobe 与 ffmpeg 同目录各自定位', () => {
    const bin = 'F:/123/ffmpeg-8.0.1/bin'
    const deps = makeDeps([`${bin}/ffmpeg.exe`, `${bin}/ffprobe.exe`], { 'F:/123': ['ffmpeg-8.0.1'] })
    expect(findInRoots('ffmpeg', ['F:/123'], deps)).toBe(`${bin}/ffmpeg.exe`)
    expect(findInRoots('ffprobe', ['F:/123'], deps)).toBe(`${bin}/ffprobe.exe`)
  })
})

describe('defaultRoots（打包后优先找包内 ffmpeg）', () => {
  it('有 resourcesPath 时排在最前——包内 ffmpeg 优先于机器上任何一份', () => {
    expect(defaultRoots('C:/app/resources')[0]).toBe('C:/app/resources')
  })

  it('无 resourcesPath（开发态/普通 Node）时不插入 undefined 条目', () => {
    const roots = defaultRoots(undefined)
    expect(roots).toEqual(DEFAULT_ROOTS)
    expect(roots.every(r => typeof r === 'string' && r.length > 0)).toBe(true)
  })

  it('包内布局 resources/ffmpeg/bin/ 能被 findInRoots 命中', () => {
    const rp = 'C:/app/resources'
    const deps = makeDeps([`${rp}/ffmpeg/bin/ffprobe.exe`], { [rp]: ['ffmpeg'] })
    expect(findInRoots('ffprobe', defaultRoots(rp), deps)).toBe(`${rp}/ffmpeg/bin/ffprobe.exe`)
  })

  it('包内没有时仍回落到机器上的 /123 目录', () => {
    const rp = 'C:/app/resources'
    const deps = makeDeps(
      ['E:/123/ffmpeg-8.0.1/bin/ffmpeg.exe'],
      { [rp]: [], 'E:/123': ['ffmpeg-8.0.1'] }
    )
    expect(findInRoots('ffmpeg', defaultRoots(rp), deps)).toBe('E:/123/ffmpeg-8.0.1/bin/ffmpeg.exe')
  })
})

describe('resolveBin', () => {
  it('roots 命中时优先于 PATH', () => {
    const deps = makeDeps(
      ['E:/123/ffmpeg-8.0.1/bin/ffmpeg.exe', 'C:/other/ffmpeg.exe'],
      { 'E:/123': ['ffmpeg-8.0.1'] }
    )
    expect(resolveBin('ffmpeg', { deps, roots: ['E:/123'], pathEnv: 'C:/other' }))
      .toBe('E:/123/ffmpeg-8.0.1/bin/ffmpeg.exe')
  })

  it('roots 全落空时回落到 PATH', () => {
    const deps = makeDeps(['C:/other/ffmpeg.exe'])
    expect(resolveBin('ffmpeg', { deps, roots: ['F:/123'], pathEnv: 'C:/other' }))
      .toBe('C:/other/ffmpeg.exe')
  })

  it('都找不到 → null', () => {
    const deps = makeDeps([])
    expect(resolveBin('ffmpeg', { deps, roots: ['F:/123'], pathEnv: 'C:/nope' })).toBeNull()
  })
})
