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
import { findFfmpeg, extractAudio, extractFrames } from '../src/main/asr/media'

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
