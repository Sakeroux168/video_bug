import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBin } from '../src/main/ffbin'
import { displayDimensions, normalizeVideo, probeMedia, targetDimensions } from '../src/main/videoNormalizer'

const ffmpeg = findBin('ffmpeg')
const ffprobe = findBin('ffprobe')

function makeColorVideo(path: string, width: number, height: number): void {
  execFileSync(ffmpeg!, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=blue:s=${width}x${height}:d=0.2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path
  ], { windowsHide: true, timeout: 15000 })
}

function makeTestVideo(path: string, width: number, height: number, withAudio: boolean): void {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=s=${width}x${height}:r=10:d=0.4`
  ]
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-shortest')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p')
  if (withAudio) args.push('-c:a', 'aac')
  args.push('-y', path)
  execFileSync(ffmpeg!, args, { windowsHide: true, timeout: 15000 })
}

describe.skipIf(!ffmpeg || !ffprobe)('本机真实 FFmpeg 媒体探测', () => {
  it.each([
    [160, 120, { width: 1920, height: 1080 }],
    [120, 160, { width: 1080, height: 1920 }],
    [120, 120, { width: 1080, height: 1920 }]
  ])('探测 %sx%s MP4 并选择正确目标尺寸', async (width, height, target) => {
    const dir = mkdtempSync(join(tmpdir(), 'normalizer-probe-'))
    try {
      const path = join(dir, 'sample.mp4')
      makeColorVideo(path, width, height)
      const probe = await probeMedia(path)
      expect(probe).toMatchObject({ width, height, videoCodec: 'h264', pixelFormat: 'yuv420p' })
      expect(targetDimensions(probe!)).toEqual(target)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('识别真实 MP4 display matrix 旋转并按显示方向分类', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'normalizer-rotate-'))
    try {
      const source = join(dir, 'source.mp4')
      const rotated = join(dir, 'rotated.mp4')
      makeColorVideo(source, 120, 160)
      execFileSync(ffmpeg!, [
        '-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90',
        '-i', source, '-c', 'copy', '-y', rotated
      ], { windowsHide: true, timeout: 15000 })

      const probe = await probeMedia(rotated)
      expect(Math.abs(probe!.rotation)).toBe(90)
      expect(displayDimensions(probe!)).toEqual({ width: 160, height: 120 })
      expect(targetDimensions(probe!)).toEqual({ width: 1920, height: 1080 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it.each([
    ['横屏', 160, 90, true, { width: 1920, height: 1080 }],
    ['竖屏', 90, 160, false, { width: 1080, height: 1920 }],
    ['正方形', 120, 120, false, { width: 1080, height: 1920 }],
    ['4:3', 160, 120, false, { width: 1920, height: 1080 }],
    ['超宽', 320, 80, false, { width: 1920, height: 1080 }],
    ['低分辨率', 64, 96, false, { width: 1080, height: 1920 }]
  ])('%s样本真实转码为目标尺寸并保持时长/音轨语义', async (_label, width, height, withAudio, target) => {
    const dir = mkdtempSync(join(tmpdir(), 'normalizer-live-'))
    try {
      const source = join(dir, 'source.mp4')
      const output = join(dir, 'normalized.part.mp4')
      makeTestVideo(source, width, height, withAudio)
      const sourceProbe = await probeMedia(source)
      const result = await normalizeVideo({ inputPath: source, outputPath: output })
      const outputProbe = await probeMedia(output)

      expect(result).toMatchObject({ status: 'normalized', target })
      expect(outputProbe).toMatchObject({
        width: target.width,
        height: target.height,
        rotation: 0,
        sampleAspectRatio: '1:1',
        pixelFormat: 'yuv420p',
        videoCodec: 'h264',
        audioCodec: withAudio ? 'aac' : null
      })
      expect(Math.abs(outputProbe!.durationSec - sourceProbe!.durationSec)).toBeLessThanOrEqual(0.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  it('带旋转元数据的竖编码源按显示方向转成物理横屏且清除旋转', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'normalizer-autorotate-'))
    try {
      const source = join(dir, 'source.mp4')
      const rotated = join(dir, 'rotated.mp4')
      const output = join(dir, 'normalized.part.mp4')
      makeTestVideo(source, 90, 160, false)
      execFileSync(ffmpeg!, [
        '-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90',
        '-i', source, '-c', 'copy', '-y', rotated
      ], { windowsHide: true, timeout: 15000 })

      await expect(normalizeVideo({ inputPath: rotated, outputPath: output }))
        .resolves.toMatchObject({ status: 'normalized', target: { width: 1920, height: 1080 } })
      await expect(probeMedia(output)).resolves.toMatchObject({ width: 1920, height: 1080, rotation: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
