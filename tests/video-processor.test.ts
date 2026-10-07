import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { VideoProcessor, scanVideoFiles } from '../src/main/videoProcessor'
import type { NormalizeVideoRequest, NormalizeVideoResult } from '../src/main/videoNormalizer'
import type { ProcessState } from '../src/shared/types'

// 「视频处理」页的主进程批处理器：递归发现视频 → 逐个调用现有 videoNormalizer → 安全替换。
// 核心红线：任何失败/中止都不能删除或损坏源文件；pause/stop 必须真的打断后续工作。

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vp-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function put(segments: string[], content = 'x'.repeat(2048)): string {
  const p = join(tmp, ...segments)
  mkdirSync(join(tmp, ...segments.slice(0, -1)), { recursive: true })
  writeFileSync(p, content)
  return p
}

const V1080 = { width: 1920, height: 1080 }
const V720 = { width: 1280, height: 720 }

type Normalize = (req: NormalizeVideoRequest) => Promise<NormalizeVideoResult>

/** 按文件名决定假 normalizer 的行为：ok-* 已兼容、bad-* 转码失败、其它成功转码并写出输出 */
function fakeNormalize(over: Partial<Record<string, Normalize>> = {}): Normalize {
  return async req => {
    const name = req.inputPath.replace(/\\/g, '/').split('/').pop()!
    const custom = over[name]
    if (custom) return custom(req)
    req.onProbe?.({ source: V720, target: V1080 })
    if (name.startsWith('ok-')) return { status: 'skipped', target: V1080, source: V1080 }
    if (name.startsWith('bad-')) return { status: 'failed', error: 'ffmpeg_failed', target: V1080, source: V720 }
    writeFileSync(req.outputPath, 'NORMALIZED'.repeat(200))
    return { status: 'normalized', target: V1080, source: V720 }
  }
}

function make(normalize: Normalize): { vp: VideoProcessor; states: ProcessState[]; replaced: Array<{ path: string; backup: string; target: { width: number; height: number } }> } {
  const states: ProcessState[] = []
  const replaced: Array<{ path: string; backup: string; target: { width: number; height: number } }> = []
  // 2026-10-07 性能 F8 起推送默认节流（最多每 250ms 一次）；这里测的是每一步的状态，所以关掉节流（间隔 0）
  const vp = new VideoProcessor({ normalize, emitIntervalMs: 0, onChange: s => states.push(structuredClone(s)), onReplaced: info => replaced.push(info) })
  return { vp, states, replaced }
}

async function untilPhase(vp: VideoProcessor, ...phases: ProcessState['phase'][]): Promise<ProcessState> {
  await vi.waitFor(() => expect(phases).toContain(vp.getState().phase), { timeout: 3000 })
  return vp.getState()
}

describe('scanVideoFiles（递归发现）', () => {
  it('递归收集子文件夹里的 .mp4，跳过 .original.mp4、隐藏/临时项与非视频文件，按路径排序', () => {
    put(['a.mp4'])
    put(['sub', 'deep', 'b.MP4'])
    put(['sub', 'c.mp4'])
    put(['sub', 'c.original.mp4'])
    put(['sub', '.video-process-1.part.mp4'])
    put(['.hidden', 'h.mp4'])
    put(['~tmp', 't.mp4'])
    put(['cover.jpg'])
    put(['note.txt'])
    expect(scanVideoFiles(tmp)).toEqual([
      join(tmp, 'a.mp4'),
      join(tmp, 'sub', 'c.mp4'),
      join(tmp, 'sub', 'deep', 'b.MP4')
    ])
  })

  it('目录不存在 → 空数组，不抛', () => {
    expect(scanVideoFiles(join(tmp, 'nope'))).toEqual([])
  })
})

describe('VideoProcessor 批处理', () => {
  it('混合批次：已兼容跳过、需要转码的原地替换并把原片留成 .original.mp4、失败的源文件原样保留', async () => {
    const okPath = put(['ok-1.mp4'], 'OK'.repeat(1024))
    const needPath = put(['sub', 'need-1.mp4'], 'SRC'.repeat(1024))
    const badPath = put(['bad-1.mp4'], 'BAD'.repeat(1024))
    const { vp, states, replaced } = make(fakeNormalize())

    expect(vp.start(tmp)).toEqual({ ok: true })
    const s = await untilPhase(vp, 'finished')
    // 只有真正替换成功的文件才回调（跳过/失败的都不），供主进程把备份路径回写库里
    expect(replaced).toEqual([{ path: needPath, backup: join(tmp, 'sub', 'need-1.original.mp4'), target: V1080 }])

    expect(s).toMatchObject({ total: 3, done: 1, skipped: 1, failed: 1, completed: 2, processing: 0, remaining: 0, current: null, dir: tmp })
    const byName = Object.fromEntries(s.items.map(i => [i.name, i]))
    expect(byName['ok-1.mp4']).toMatchObject({ status: 'skipped', source: V1080, target: V1080 })
    expect(byName['need-1.mp4']).toMatchObject({ status: 'done', source: V720, target: V1080 })
    expect(byName['bad-1.mp4']).toMatchObject({ status: 'failed', error: 'ffmpeg_failed' })

    // 已兼容：一个字节都不动
    expect(readFileSync(okPath, 'utf8')).toBe('OK'.repeat(1024))
    // 转码成功：原文件名指向转码结果，原片改名为 .original.mp4 留在同目录
    expect(readFileSync(needPath, 'utf8')).toBe('NORMALIZED'.repeat(200))
    expect(readFileSync(join(tmp, 'sub', 'need-1.original.mp4'), 'utf8')).toBe('SRC'.repeat(1024))
    // 失败：源文件原样、没有备份、没有临时文件
    expect(readFileSync(badPath, 'utf8')).toBe('BAD'.repeat(1024))
    expect(existsSync(join(tmp, 'bad-1.original.mp4'))).toBe(false)
    expect(readdirSync(tmp).some(n => n.includes('.part.'))).toBe(false)
    expect(readdirSync(join(tmp, 'sub')).some(n => n.includes('.part.'))).toBe(false)
    // 日志与状态推送
    expect(s.log.some(l => l.includes('need-1.mp4'))).toBe(true)
    expect(s.log.some(l => l.includes('bad-1.mp4') && l.includes('ffmpeg_failed'))).toBe(true)
    expect(states.length).toBeGreaterThan(3)
  })

  it('处理中：current 带文件名，探测回调后补上原始/目标尺寸，processing=1、remaining 递减', async () => {
    put(['need-1.mp4'])
    put(['need-2.mp4'])
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let probeSeen: ProcessState | null = null
    const { vp } = make(fakeNormalize({
      'need-1.mp4': async req => {
        req.onProbe?.({ source: V720, target: V1080 })
        probeSeen = structuredClone(vp.getState())
        await gate
        writeFileSync(req.outputPath, 'N'.repeat(2048))
        return { status: 'normalized', target: V1080, source: V720 }
      }
    }))
    vp.start(tmp)
    await vi.waitFor(() => expect(probeSeen).not.toBeNull())
    expect(probeSeen!).toMatchObject({
      phase: 'running', total: 2, processing: 1, remaining: 1, completed: 0,
      current: { name: 'need-1.mp4', source: V720, target: V1080 }
    })
    expect(probeSeen!.items[0]).toMatchObject({ name: 'need-1.mp4', status: 'processing', source: V720, target: V1080 })
    release()
    const s = await untilPhase(vp, 'finished')
    expect(s).toMatchObject({ done: 2, completed: 2, remaining: 0, current: null })
  })

  it('normalizer 抛异常（非预期错误）：该文件记 failed，源文件不动，后续文件照常处理', async () => {
    const p1 = put(['need-1.mp4'], 'A'.repeat(2048))
    put(['need-2.mp4'])
    const { vp } = make(fakeNormalize({
      'need-1.mp4': async () => { throw new Error('boom') }
    }))
    vp.start(tmp)
    const s = await untilPhase(vp, 'finished')
    expect(s).toMatchObject({ done: 1, failed: 1 })
    expect(s.items[0]).toMatchObject({ name: 'need-1.mp4', status: 'failed', error: 'ffmpeg_failed' })
    expect(readFileSync(p1, 'utf8')).toBe('A'.repeat(2048))
    expect(existsSync(join(tmp, 'need-1.original.mp4'))).toBe(false)
  })

  it('同名 .original.mp4 已存在：视为本工具处理过，跳过且不转码，源文件与旧备份都不动、绝不覆盖', async () => {
    const src = put(['need-1.mp4'], 'SRC'.repeat(1024))
    put(['need-1.original.mp4'], 'OLD'.repeat(1024))
    const normalize = vi.fn(fakeNormalize())
    const { vp } = make(normalize)
    vp.start(tmp)
    const s = await untilPhase(vp, 'finished')
    expect(s.items[0]).toMatchObject({ status: 'skipped' })
    expect(s.log.some(l => l.includes('need-1.original.mp4'))).toBe(true)
    expect(normalize).not.toHaveBeenCalled()
    expect(readFileSync(src, 'utf8')).toBe('SRC'.repeat(1024))
    expect(readFileSync(join(tmp, 'need-1.original.mp4'), 'utf8')).toBe('OLD'.repeat(1024))
  })

  it('暂停：当前文件处理完后不再开始下一个；继续后接着处理', async () => {
    put(['need-1.mp4'])
    put(['need-2.mp4'])
    put(['need-3.mp4'])
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const normalize = vi.fn(fakeNormalize({
      'need-1.mp4': async req => {
        await gate
        writeFileSync(req.outputPath, 'N'.repeat(2048))
        return { status: 'normalized', target: V1080, source: V720 }
      }
    }))
    const { vp } = make(normalize)
    vp.start(tmp)
    await vi.waitFor(() => expect(normalize).toHaveBeenCalledTimes(1))
    vp.pause()
    expect(vp.getState().phase).toBe('paused')
    release()
    // 第一个文件收尾后必须停在 paused：完成数到 1，但第二个文件不能开始
    await vi.waitFor(() => expect(vp.getState().completed).toBe(1))
    await new Promise(r => setTimeout(r, 50))
    expect(normalize).toHaveBeenCalledTimes(1)
    expect(vp.getState()).toMatchObject({ phase: 'paused', processing: 0, remaining: 2 })

    vp.resume()
    const s = await untilPhase(vp, 'finished')
    expect(normalize).toHaveBeenCalledTimes(3)
    expect(s).toMatchObject({ done: 3, remaining: 0 })
  })

  it('停止：中止当前转码（signal 触发）、清理临时文件、源文件不动，剩余项标 stopped，不再开始新文件', async () => {
    const p1 = put(['need-1.mp4'], 'A'.repeat(2048))
    put(['need-2.mp4'])
    put(['need-3.mp4'])
    const normalize = vi.fn(fakeNormalize({
      'need-1.mp4': async req => {
        writeFileSync(req.outputPath, 'HALF') // 半成品
        await new Promise<void>(resolve => req.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'aborted', target: V1080, source: V720 }
      }
    }))
    const { vp } = make(normalize)
    vp.start(tmp)
    await vi.waitFor(() => expect(normalize).toHaveBeenCalledTimes(1))
    vp.stop()
    const s = await untilPhase(vp, 'stopped')
    expect(normalize).toHaveBeenCalledTimes(1)
    expect(s.items.map(i => i.status)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(s).toMatchObject({ processing: 0, current: null, done: 0 })
    expect(readFileSync(p1, 'utf8')).toBe('A'.repeat(2048))
    expect(existsSync(join(tmp, 'need-1.original.mp4'))).toBe(false)
    expect(readdirSync(tmp).some(n => n.includes('.part.'))).toBe(false)
  })

  it('暂停态下停止：直接进入 stopped，剩余项标 stopped', async () => {
    put(['need-1.mp4'])
    put(['need-2.mp4'])
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { vp } = make(fakeNormalize({
      'need-1.mp4': async req => {
        await gate
        writeFileSync(req.outputPath, 'N'.repeat(2048))
        return { status: 'normalized', target: V1080, source: V720 }
      }
    }))
    vp.start(tmp)
    await vi.waitFor(() => expect(vp.getState().processing).toBe(1))
    vp.pause()
    release()
    await vi.waitFor(() => expect(vp.getState().completed).toBe(1))
    vp.stop()
    const s = await untilPhase(vp, 'stopped')
    expect(s.items.map(i => i.status)).toEqual(['done', 'stopped'])
  })

  it('运行中不允许再次 start；目录不存在 / 不是目录 → 明确错误；停止或完成后可以再次 start', async () => {
    put(['need-1.mp4'])
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { vp } = make(fakeNormalize({
      'need-1.mp4': async req => {
        await gate
        writeFileSync(req.outputPath, 'N'.repeat(2048))
        return { status: 'normalized', target: V1080, source: V720 }
      }
    }))
    expect(vp.start(join(tmp, 'nope')).ok).toBe(false)
    expect(vp.start(join(tmp, 'need-1.mp4')).ok).toBe(false)
    expect(vp.start(tmp)).toEqual({ ok: true })
    expect(vp.start(tmp).ok).toBe(false)
    release()
    await untilPhase(vp, 'finished')
    put(['ok-2.mp4'])
    expect(vp.start(tmp)).toEqual({ ok: true })
    const s = await untilPhase(vp, 'finished')
    // 第二轮重新扫描：need-1（已有备份 → 跳过）+ 新加的 ok-2（已兼容 → 跳过）；备份文件本身不进批次
    expect(s.total).toBe(2)
    expect(s.items.map(i => [i.name, i.status])).toEqual([['need-1.mp4', 'skipped'], ['ok-2.mp4', 'skipped']])
  })

  it('空文件夹：直接 finished，total=0，日志说明没有可处理的视频', async () => {
    mkdirSync(join(tmp, 'empty'))
    const { vp } = make(fakeNormalize())
    expect(vp.start(join(tmp, 'empty'))).toEqual({ ok: true })
    const s = await untilPhase(vp, 'finished')
    expect(s).toMatchObject({ total: 0, completed: 0, remaining: 0 })
    expect(s.log.some(l => l.includes('没有'))).toBe(true)
  })

  it('替换阶段失败（临时文件在转码后被外部删掉）：记 replace_failed，源文件回到原名、不留备份', async () => {
    const src = put(['need-1.mp4'], 'SRC'.repeat(1024))
    const { vp } = make(fakeNormalize({
      'need-1.mp4': async () => ({ status: 'normalized', target: V1080, source: V720 }) // 声称成功但没写输出
    }))
    vp.start(tmp)
    const s = await untilPhase(vp, 'finished')
    expect(s.items[0]).toMatchObject({ status: 'failed', error: 'replace_failed' })
    expect(readFileSync(src, 'utf8')).toBe('SRC'.repeat(1024))
    expect(existsSync(join(tmp, 'need-1.original.mp4'))).toBe(false)
  })
})
