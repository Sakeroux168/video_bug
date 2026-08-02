// tests/asr-media.test.ts — ASR ffmpeg 抽音轨/抽帧封装（Task 10）
//
// 需要本机有 ffmpeg：用 findFfmpeg() 定位（应在 F:/123/ffmpeg*/bin/ffmpeg.exe）。
// 找到就用 ffmpeg 现造一段 2 秒测试视频（视频+音频轨），再验证抽音轨/抽帧的产物；
// 找不到就整组跳过（describe.skipIf）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { findFfmpeg, extractAudio, extractFrames, Semaphore } from '../src/main/asr/media'

/** 轮询等待一个条件成立；测试里用来等异步微任务推进 */
async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor 超时')
    await new Promise(r => setTimeout(r, 5))
  }
}

/** 给 Promise 套一个短超时：超时 reject，用于验证"不会挂起"（死锁检测） */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(msg)), ms)
  })
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

// 测试用 ffmpeg：找不到则整组跳过
const ffmpeg = findFfmpeg()

let dir: string
let src: string

// 造一段 2 秒测试视频：testsrc 视频轨（10fps 320x240）+ sine 音轨（440Hz），编码成 mp4
function makeTestVideo(d: string): string {
  const p = join(d, 'test.mp4')
  execFileSync(ffmpeg!, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    '-y', p
  ])
  return p
}

// 读 wav 头：声道数(offset 22) 和采样率(offset 24) —— 校验确实是 16kHz 单声道
function wavInfo(p: string): { channels: number; rate: number } {
  const b = readFileSync(p)
  return { channels: b.readUInt16LE(22), rate: b.readUInt32LE(24) }
}

describe.skipIf(!ffmpeg)('asr-media ffmpeg 封装', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asr-media-'))
    src = makeTestVideo(dir)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('extractAudio 产出 >0 字节的 16kHz 单声道 wav', async () => {
    const wav = join(dir, 'audio.wav')

    await extractAudio(ffmpeg!, src, wav, { maxSec: 1.5 })

    expect(existsSync(wav)).toBe(true)
    expect(statSync(wav).size).toBeGreaterThan(0)
    const info = wavInfo(wav)
    expect(info.channels).toBe(1) // 单声道
    expect(info.rate).toBe(16000) // 16kHz
  })

  it('extractFrames(count:3) 产出 3 张 >0 字节的 jpg', async () => {
    const frames = await extractFrames(ffmpeg!, src, join(dir, 'frames'), { count: 3 })

    expect(frames).toHaveLength(3)
    for (const f of frames) {
      expect(f).toMatch(/frame_0[123]\.jpg$/)
      expect(existsSync(f)).toBe(true)
      expect(statSync(f).size).toBeGreaterThan(0)
    }
  })
})

// ==========================
// Semaphore 并发闸门（回归）
// ==========================
// 以前实现里排队分支会 active++，导致每交接一次计数净 +1：
// max=2 时 4 个并发跑完 active 停在 2 却无人运行，后续 acquire 永远挂起死锁。
// 这个测试用可控 Promise 复现该场景，并验证修复后不会死锁。
describe('Semaphore 并发闸门', () => {
  it('max=2 连续 4 个 run 全部完成，后续 acquire 不挂起（防死锁回归）', async () => {
    const sem = new Semaphore(2)
    const calls: number[] = [] // 记录每个 fn 开始执行的序号
    const gates: Array<Promise<void>> = []
    const release: Array<() => void> = []
    for (let i = 0; i < 4; i++) gates.push(new Promise<void>(r => release.push(r)))

    let running = 0
    let maxSeen = 0

    // 4 个任务：进场先记 running，等各自的 gate 释放后才算完成 ——
    // 这样能精确控制 2 个先跑、另 2 个排队交接的顺序
    const tasks = Array.from({ length: 4 }, (_, i) => sem.run(async () => {
      running++
      maxSeen = Math.max(maxSeen, running)
      calls.push(i)
      await gates[i]
      running--
    }))

    // 前 2 个拿到名额直接跑，后 2 个排队
    await waitFor(() => calls.length === 2)
    expect(calls).toEqual([0, 1])

    // 放行第 0 个 → 名额交给队首（第 2 个进场）；放行第 1 个 → 第 3 个进场
    release[0]()
    await waitFor(() => calls.length === 3)
    release[1]()
    await waitFor(() => calls.length === 4)
    expect(calls).toEqual([0, 1, 2, 3])

    // 放行后两个，整批完成
    release[2]()
    release[3]()
    await Promise.all(tasks)

    // 并发从未超过 max，任务全部跑完（计数归零）
    expect(maxSeen).toBeLessThanOrEqual(2)
    expect(running).toBe(0)

    // 关键：整批结束后再 acquire 不应挂起 —— 短超时验证非死锁
    let ok = false
    await withTimeout(sem.run(async () => { ok = true }), 500, '闸门死锁：整批结束后的 acquire 挂起')
    expect(ok).toBe(true)
  })
})
