import type { Dirent } from 'node:fs'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { normalizeVideo } from './videoNormalizer'
import type { NormalizeVideoRequest, NormalizeVideoResult } from './videoNormalizer'
import { isCountedVideo } from './fileManager'
import type { ProcessItem, ProcessOptions, ProcessPhase, ProcessState } from '../shared/types'

/** 「已处理」模式的输出文件夹名（放在所选文件夹下）；扫描时跳过它，免得把结果又当成待处理 */
export const PROCESSED_DIR_NAME = '已处理'

/**
 * 「视频处理」页的主进程批处理器：用户选一个文件夹 → 递归发现 .mp4 → 逐个交给现有 videoNormalizer
 * （竖屏 1080×1920 / 横屏 1920×1080、主体等比、模糊背景）→ 成功后安全替换。
 *
 * 输出策略（界面上也这么说明）：
 *   转码写到同目录的隐藏临时文件 .video-process-<n>.part.mp4；normalizer 验证输出合格后，
 *   先把原文件改名为 <名字>.original.mp4 备份，再把临时文件改名为原文件名。
 *   任何失败/中止只删临时文件，源文件一个字节都不动；已有 .original.mp4 备份的文件视为处理过，直接跳过。
 *
 * 暂停 = 当前文件处理完后不再开始下一个（FFmpeg 转码没有断点，中途掐断等于白做）；
 * 停止 = 立即中止当前转码（AbortSignal → kill FFmpeg）、清理临时文件，剩余项标 stopped。
 * 并发默认 1：libx264 本身就吃满 CPU，多开只会互相拖慢；构造参数留了口子但界面不暴露。
 */

export interface VideoProcessorDeps {
  normalize?: (request: NormalizeVideoRequest) => Promise<NormalizeVideoResult>
  /** 状态每变一次推一次完整快照（渲染层据此刷新，没有增量协议要维护） */
  onChange?: (state: ProcessState) => void
  /** 某个文件原地替换成功后回调：主进程用它把 .original.mp4 路径与新尺寸回写 videos 行，
   *  之后归档移动 / 程序内删除仍能把备份成对带走，不留孤儿文件。处理器本身不碰数据库。 */
  onReplaced?: (info: { path: string; backup: string; target: { width: number; height: number } }) => void
  concurrency?: number
  /** 注入时钟便于测试；日志行前缀 HH:MM:SS */
  now?: () => Date
}

const LOG_LIMIT = 200

/** 隐藏/临时目录或文件（~ 或 . 开头）一律不碰，与文件管理同一规则 */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~')
}

/** 递归收集目录里可处理的视频（.mp4，排除 .original.mp4 备份与隐藏/临时项），按路径排序保证批次顺序稳定 */
export function scanVideoFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    const dirs: string[] = []
    const files: string[] = []
    for (const e of entries) {
      if (isIgnoredName(e.name)) continue
      if (e.isDirectory() && e.name === PROCESSED_DIR_NAME) continue // 上一轮的处理结果，不再当原片处理
      if (e.isDirectory()) dirs.push(e.name)
      else if (e.isFile() && isCountedVideo(e.name)) files.push(e.name)
    }
    files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    dirs.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    for (const f of files) out.push(join(d, f))
    for (const s of dirs) walk(join(d, s))
  }
  walk(dir)
  return out
}

/** 原片备份路径：<目录>/<名字>.original.mp4（与旧版下载转码流程、文件管理的过滤规则一致） */
export function backupPathFor(videoPath: string): string {
  const ext = extname(videoPath)
  return join(dirname(videoPath), `${basename(videoPath, ext)}.original.mp4`)
}

export class VideoProcessor {
  private phase: ProcessPhase = 'idle'
  private dir: string | null = null
  private options: ProcessOptions = {}
  /** 「已处理」模式的输出根目录；原地替换模式为 null */
  private outputDir: string | null = null
  private dropBackup = false
  private items: ProcessItem[] = []
  private log: string[] = []
  private active = 0
  private runId = 0
  private aborters = new Map<ProcessItem, AbortController>()
  private readonly normalize: (request: NormalizeVideoRequest) => Promise<NormalizeVideoResult>
  private readonly concurrency: number
  private readonly now: () => Date

  constructor(private deps: VideoProcessorDeps = {}) {
    this.normalize = deps.normalize ?? normalizeVideo
    this.concurrency = Math.max(1, deps.concurrency ?? 1)
    this.now = deps.now ?? (() => new Date())
  }

  getState(): ProcessState {
    const count = (status: ProcessItem['status']): number => this.items.filter(i => i.status === status).length
    const processing = this.items.filter(i => i.status === 'processing')
    const done = count('done')
    const skipped = count('skipped')
    return {
      phase: this.phase,
      dir: this.dir,
      total: this.items.length,
      completed: done + skipped,
      done,
      skipped,
      failed: count('failed'),
      processing: processing.length,
      remaining: count('pending'),
      current: processing[0] ? { name: processing[0].name, source: processing[0].source, target: processing[0].target } : null,
      items: this.items.map(i => ({ ...i })),
      log: [...this.log],
      outputDir: this.outputDir
    }
  }

  /** 选定文件夹开始一轮：运行/暂停/停止中不允许再开；目录必须存在。扫描是同步 readdir，几千个文件也在毫秒级。
   *  extra 只由主进程传，界面传不进来（素材库打包交付后统一分辨率用）：
   *  only = 只处理这几个文件，交付文件夹里原来就有的视频不碰；
   *  dropBackup = 替换成功后删掉 .original.mp4（交付的是复制品，原片还在下载目录，不能让备份混进交付文件夹） */
  start(dir: string, options: ProcessOptions = {}, extra: { only?: string[]; dropBackup?: boolean } = {}): { ok: boolean; error?: string } {
    if (this.phase === 'running' || this.phase === 'paused' || this.phase === 'stopping') {
      return { ok: false, error: '当前还有一轮处理没结束，请先停止' }
    }
    try {
      if (!statSync(dir).isDirectory()) return { ok: false, error: '不是文件夹' }
    } catch {
      return { ok: false, error: '文件夹不存在' }
    }
    this.runId++
    this.dir = dir
    this.options = options
    this.outputDir = options.mode === 'folder' ? join(dir, PROCESSED_DIR_NAME) : null
    this.log = []
    this.dropBackup = extra.dropBackup === true
    const allow = extra.only ? new Set(extra.only.map(p => resolve(p).toLowerCase())) : null
    this.items = scanVideoFiles(dir)
      .filter(path => !allow || allow.has(resolve(path).toLowerCase()))
      .map(path => ({ path, name: basename(path), status: 'pending' as const }))
    if (this.items.length === 0) {
      this.phase = 'finished'
      this.pushLog(`${dir} 里没有可处理的 .mp4 视频`)
      this.emit()
      return { ok: true }
    }
    this.phase = 'running'
    this.pushLog(`开始处理 ${dir}，共发现 ${this.items.length} 个视频`)
    this.emit()
    this.drain()
    return { ok: true }
  }

  /** 暂停：不再开始新文件；正在转码的那个跑完（中途掐断等于白做，且 FFmpeg 没有断点） */
  pause(): void {
    if (this.phase !== 'running') return
    this.phase = 'paused'
    this.pushLog(this.active > 0 ? '已暂停：当前文件处理完后不再开始下一个' : '已暂停')
    this.emit()
  }

  resume(): void {
    if (this.phase !== 'paused') return
    this.phase = 'running'
    this.pushLog('继续处理')
    this.emit()
    this.drain()
  }

  /** 停止：中止在途转码（signal → kill FFmpeg，临时文件由 normalizer 清理），剩余项标 stopped，不再开始新文件 */
  stop(): void {
    if (this.phase !== 'running' && this.phase !== 'paused') return
    for (const item of this.items) if (item.status === 'pending') item.status = 'stopped'
    if (this.active === 0) {
      this.phase = 'stopped'
      this.pushLog('已停止')
    } else {
      this.phase = 'stopping'
      this.pushLog('正在停止：中止当前转码…')
      for (const aborter of this.aborters.values()) aborter.abort()
    }
    this.emit()
  }

  private emit(): void {
    this.deps.onChange?.(this.getState())
  }

  private pushLog(message: string): void {
    const t = this.now()
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    const ss = String(t.getSeconds()).padStart(2, '0')
    this.log.push(`${hh}:${mm}:${ss} ${message}`)
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
  }

  private drain(): void {
    while (this.phase === 'running' && this.active < this.concurrency) {
      const next = this.items.find(i => i.status === 'pending')
      if (!next) break
      this.active++
      const runId = this.runId
      void this.runOne(next).finally(() => {
        this.active--
        if (runId !== this.runId) return // 已被新一轮 start 取代（理论上不会：start 拒绝在未结束时开新轮）
        this.settle()
      })
    }
  }

  /** 每个文件收尾后决定整体走向：停止中 → stopped；没活了 → finished；否则继续拉下一个 */
  private settle(): void {
    if (this.phase === 'stopping') {
      if (this.active === 0) {
        this.phase = 'stopped'
        this.pushLog('已停止')
      }
      this.emit()
      return
    }
    if (this.phase === 'running') {
      const pending = this.items.some(i => i.status === 'pending')
      if (!pending && this.active === 0) {
        this.phase = 'finished'
        const s = this.getState()
        this.pushLog(`全部完成：转码 ${s.done}，已符合跳过 ${s.skipped}，失败 ${s.failed}`)
        this.emit()
        return
      }
      this.emit()
      this.drain()
      return
    }
    // paused：当前文件已收尾，停在这里等 resume
    this.emit()
  }

  private async runOne(item: ProcessItem): Promise<void> {
    try { item.sizeBefore = statSync(item.path).size } catch { /* 文件刚被删掉：交给后面的探测报错 */ }
    if (this.outputDir && this.dir) return this.runOneToFolder(item, this.outputDir, this.dir)
    const backup = backupPathFor(item.path)
    // 已有备份 = 本工具处理过（旧版下载转码或上一轮处理），不重复转码也绝不覆盖别人的备份
    if (existsSync(backup)) {
      item.status = 'skipped'
      this.pushLog(`跳过 ${item.name}：已有 ${basename(backup)} 备份，视为已处理`)
      return
    }
    item.status = 'processing'
    this.emit()
    const index = this.items.indexOf(item) + 1
    const temp = join(dirname(item.path), `.video-process-${index}.part.mp4`)
    rmSync(temp, { force: true })
    const aborter = new AbortController()
    this.aborters.set(item, aborter)
    let result: NormalizeVideoResult
    try {
      result = await this.normalize({
        inputPath: item.path,
        outputPath: temp,
        signal: aborter.signal,
        strict: this.options.strict,
        orientation: this.options.orientation,
        onProbe: info => {
          item.source = info.source
          item.target = info.target
          this.emit()
        }
      })
    } catch {
      // normalizer 自己不抛（结果都用状态表达）；真抛了只能当转码失败，源文件不动
      result = aborter.signal.aborted ? { status: 'aborted' } : { status: 'failed', error: 'ffmpeg_failed' }
    } finally {
      this.aborters.delete(item)
    }
    if (result.source) item.source = result.source
    if (result.target) item.target = result.target
    const size = (v?: { width: number; height: number }): string => (v ? `${v.width}×${v.height}` : '未知')

    switch (result.status) {
      case 'skipped':
        item.status = 'skipped'
        this.pushLog(`跳过 ${item.name}：已是 ${size(item.target)}，无需转码`)
        break
      case 'normalized':
        if (this.replaceInPlace(item.path, temp, backup)) {
          item.status = 'done'
          try { item.sizeAfter = statSync(item.path).size } catch { /* ignore */ }
          if (this.dropBackup) {
            rmSync(backup, { force: true })
            this.pushLog(`完成 ${item.name}：${size(item.source)} → ${size(item.target)}`)
          } else {
            this.pushLog(`完成 ${item.name}：${size(item.source)} → ${size(item.target)}，原片已备份为 ${basename(backup)}`)
          }
          try { this.deps.onReplaced?.({ path: item.path, backup, target: result.target }) } catch { /* 回写失败不影响文件本身 */ }
        } else {
          item.status = 'failed'
          item.error = 'replace_failed'
          this.pushLog(`失败 ${item.name}：替换文件失败（replace_failed），源文件未改动`)
        }
        break
      case 'failed':
        item.status = 'failed'
        item.error = result.error
        rmSync(temp, { force: true })
        this.pushLog(`失败 ${item.name}：${result.error}，源文件未改动`)
        break
      case 'aborted':
        item.status = 'stopped'
        rmSync(temp, { force: true })
        this.pushLog(`已中止 ${item.name}：临时文件已清理，源文件未改动`)
        break
    }
  }

  /**
   * 「已处理」模式（2026-10-07 O07③，界面默认）：结果写到 <所选文件夹>/已处理/<原来的相对路径>，原片原名原样不动。
   * 结果已经存在 = 上一轮处理过，跳过。临时文件放在结果所在的文件夹里（同一个盘，改名不会跨盘）。
   */
  private async runOneToFolder(item: ProcessItem, outRoot: string, srcRoot: string): Promise<void> {
    const out = join(outRoot, relative(srcRoot, item.path))
    if (existsSync(out)) {
      item.status = 'skipped'
      this.pushLog(`跳过 ${item.name}：「${PROCESSED_DIR_NAME}」里已经有了`)
      return
    }
    item.status = 'processing'
    this.emit()
    try { mkdirSync(dirname(out), { recursive: true }) } catch {
      item.status = 'failed'
      item.error = 'output_dir_failed'
      this.pushLog(`失败 ${item.name}：建不了输出文件夹，原片未改动`)
      return
    }
    const temp = join(dirname(out), `.video-process-${this.items.indexOf(item) + 1}.part.mp4`)
    rmSync(temp, { force: true })
    const aborter = new AbortController()
    this.aborters.set(item, aborter)
    let result: NormalizeVideoResult
    try {
      result = await this.normalize({
        inputPath: item.path, outputPath: temp, signal: aborter.signal,
        strict: this.options.strict, orientation: this.options.orientation,
        onProbe: info => { item.source = info.source; item.target = info.target; this.emit() }
      })
    } catch {
      result = aborter.signal.aborted ? { status: 'aborted' } : { status: 'failed', error: 'ffmpeg_failed' }
    } finally {
      this.aborters.delete(item)
    }
    if (result.source) item.source = result.source
    if (result.target) item.target = result.target
    const size = (v?: { width: number; height: number }): string => (v ? `${v.width}×${v.height}` : '未知')
    switch (result.status) {
      case 'skipped':
        item.status = 'skipped'
        this.pushLog(`跳过 ${item.name}：已是 ${size(item.target)}，不用处理（原片还在原来的位置）`)
        break
      case 'normalized':
        try {
          if (!existsSync(temp) || statSync(temp).size === 0) throw new Error('empty')
          renameSync(temp, out)
          item.status = 'done'
          item.sizeAfter = statSync(out).size
          this.pushLog(`完成 ${item.name}：${size(item.source)} → ${size(item.target)}，放在「${PROCESSED_DIR_NAME}」里`)
        } catch {
          rmSync(temp, { force: true })
          item.status = 'failed'
          item.error = 'replace_failed'
          this.pushLog(`失败 ${item.name}：保存结果失败，原片未改动`)
        }
        break
      case 'failed':
        item.status = 'failed'
        item.error = result.error
        rmSync(temp, { force: true })
        this.pushLog(`失败 ${item.name}：${result.error}，原片未改动`)
        break
      case 'aborted':
        item.status = 'stopped'
        rmSync(temp, { force: true })
        this.pushLog(`已中止 ${item.name}：临时文件已清理，原片未改动`)
        break
    }
  }

  /**
   * 安全替换：源 → .original.mp4 备份，临时 → 源名。第二步失败就把备份改回源名，保证源文件永远在原位。
   * 临时文件不存在/为空（normalizer 声称成功但输出没了）也算失败，绝不让一个空文件顶掉源视频。
   */
  private replaceInPlace(source: string, temp: string, backup: string): boolean {
    try {
      if (!existsSync(temp) || statSync(temp).size === 0) { rmSync(temp, { force: true }); return false }
    } catch {
      return false
    }
    try {
      renameSync(source, backup)
    } catch {
      rmSync(temp, { force: true })
      return false
    }
    try {
      renameSync(temp, source)
      return true
    } catch {
      try { renameSync(backup, source) } catch { /* 源文件仍以备份名存在，日志已提示 */ }
      rmSync(temp, { force: true })
      return false
    }
  }
}
