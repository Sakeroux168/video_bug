import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBin } from '../src/main/ffbin'
import { displayDimensions, probeMedia, targetDimensions } from '../src/main/videoNormalizer'

const ffmpeg = findBin('ffmpeg')
const ffprobe = findBin('ffprobe')

function makeColorVideo(path: string, width: number, height: number): void {
  execFileSync(ffmpeg!, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `color=c=blue:s=${width}x${height}:d=0.2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path
  ], { windowsHide: true, timeout: 15000 })
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
})
