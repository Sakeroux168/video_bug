// src/main/ffbin.ts — ffmpeg / ffprobe 可执行文件定位（downloader 与 asr/media 共用）
//
// 原来两处各写一份，PATH 兜底都是 spawnSync('where', ..., { encoding: 'utf8' })。
// 坑：中文 locale 的 Windows 上 where.exe 按 GBK(936) 输出，按 utf8 解码 → 乱码路径 → spawn ENOENT。
// 老机 ffmpeg 在 F:/123（纯 ASCII 且被目录扫描直接命中）从没走到兜底，所以一直没暴露。
// 现在不 shell out 了：process.env.PATH 由 Node 解码好，直接扫，中文路径也稳。
//
// 查找顺序：先扫各盘符下的 <盘>:/123/ffmpeg*/bin/（沿用本项目既有约定），再扫 PATH。
// 这个文件不 import electron，主进程和普通 Node 测试都能跑。

import { existsSync, readdirSync } from 'node:fs'

/** 注入点：便于纯逻辑测试，生产走真实 fs */
export interface FfBinDeps {
  exists: (p: string) => boolean
  /** 返回目录下的条目名；目录不存在时允许抛（盘符不存在等） */
  readdir: (p: string) => string[]
}

const realDeps: FfBinDeps = {
  exists: existsSync,
  readdir: p => readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
}

/** 按本项目约定扫的根目录：老机在 F:/123，新机没有 F: 盘，顺带扫其它盘 */
export const DEFAULT_ROOTS = ['F:/123', 'E:/123', 'D:/123', 'C:/123']

/**
 * 实际使用的根目录列表。打包后 ffmpeg/ffprobe 随包放在
 * `<process.resourcesPath>/ffmpeg/bin/`，正好符合 findInRoots 的 `<root>/ffmpeg<版本>/bin/` 约定，
 * 把 resourcesPath 排在最前 —— 包内那份优先于员工机器上可能存在的任意版本，行为可预期。
 * 开发态（普通 Node / 未打包）没有 resourcesPath，返回原列表，不插入空条目。
 */
export function defaultRoots(resourcesPath: string | undefined = process.resourcesPath): string[] {
  return resourcesPath ? [resourcesPath, ...DEFAULT_ROOTS] : [...DEFAULT_ROOTS]
}

/** Windows 下可执行文件带 .exe；其它平台裸名 */
function exeNames(name: string): string[] {
  return process.platform === 'win32' ? [`${name}.exe`] : [name, `${name}.exe`]
}

/** 在 `<root>/ffmpeg<版本>/bin/` 下找可执行文件。root 不存在直接跳过 */
export function findInRoots(name: string, roots: string[], deps: FfBinDeps = realDeps): string | null {
  for (const root of roots) {
    let entries: string[]
    try {
      entries = deps.readdir(root)
    } catch {
      continue // 盘符/目录不存在
    }
    for (const dir of entries) {
      if (!/^ffmpeg/i.test(dir)) continue
      for (const exe of exeNames(name)) {
        const p = `${root}/${dir}/bin/${exe}`
        if (deps.exists(p)) return p
      }
    }
  }
  return null
}

/** 直接扫 PATH 的每个目录（不 shell out where.exe，见文件头注释） */
export function findInPathEnv(
  name: string,
  pathEnv: string | undefined,
  exists: (p: string) => boolean = existsSync
): string | null {
  if (!pathEnv) return null
  for (const raw of pathEnv.split(';')) {
    // PATH 条目可能带包裹引号，也可能是空串
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '')
    if (!dir) continue
    for (const exe of exeNames(name)) {
      const p = `${dir}/${exe}`
      if (exists(p)) return p
    }
  }
  return null
}

export interface ResolveOpts {
  deps?: FfBinDeps
  /** 随包目录（打包后的 resourcesPath）；不传就用 process.resourcesPath */
  bundledRoot?: string | null
  /** 老约定目录（<盘>:/123）；不传就用 DEFAULT_ROOTS */
  roots?: string[]
  pathEnv?: string
}

/**
 * 完整查找：随包 → PATH → 老约定目录，找不到返回 null（调用方各自兜底放行）。
 * 安全检查（2026-10-06）：以前先扫 C:/123、D:/123 等目录——普通用户也能在盘根建文件夹，
 * 别人放一个同名 ffmpeg.exe 就会被执行。现在 PATH 优先，老约定目录只在 PATH 里没有时才兜底（开发机仍可用）。
 */
export function resolveBin(name: string, opts: ResolveOpts = {}): string | null {
  const deps = opts.deps ?? realDeps
  const bundled = opts.bundledRoot === undefined ? process.resourcesPath : opts.bundledRoot
  const roots = opts.roots ?? DEFAULT_ROOTS
  const pathEnv = opts.pathEnv ?? process.env.PATH
  return (bundled ? findInRoots(name, [bundled], deps) : null)
    ?? findInPathEnv(name, pathEnv, deps.exists)
    ?? findInRoots(name, roots, deps)
}

// 结果缓存：一次会话内路径不变，避免每次下载/转写都扫盘
const cache: Record<string, string | null | undefined> = {}

/** 带缓存的定位（生产用）。测试要绕开缓存请直接用 resolveBin */
export function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  if (cache[name] !== undefined) return cache[name]!
  const p = resolveBin(name)
  cache[name] = p
  return p
}
