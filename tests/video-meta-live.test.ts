import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findBin } from '../src/main/ffbin'
import { probeVideoDimensions, screenBucket } from '../src/main/videoMeta'

const ffmpeg = findBin('ffmpeg')
const ffprobe = findBin('ffprobe')

describe.skipIf(!ffmpeg || !ffprobe)('本机真实视频方向探测', () => {
  it.each([[120, 160, '竖屏'], [160, 120, '横屏'], [120, 120, '竖屏']])(
    '实际编码 %sx%s MP4 后探测为 %s', async (width, height, expected) => {
      const dir = mkdtempSync(join(tmpdir(), 'probe-live-'))
      try {
        const path = join(dir, 'sample.mp4')
        execFileSync(ffmpeg!, [
          '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
          '-i', `color=c=blue:s=${width}x${height}:d=0.2`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path
        ], { windowsHide: true, timeout: 10000 })
        const result = await probeVideoDimensions(path)
        expect(result).toEqual({ width, height })
        expect(screenBucket(result!.width, result!.height)).toBe(expected)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }, 20000
  )
})
