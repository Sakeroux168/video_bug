import { describe, expect, it, vi } from 'vitest'
import {
  buildNormalizationFilter,
  displayDimensions,
  isAlreadyCompatible,
  probeMedia,
  targetDimensions,
  type MediaProbe
} from '../src/main/videoNormalizer'

function media(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    width: 1920,
    height: 1080,
    rotation: 0,
    sampleAspectRatio: '1:1',
    pixelFormat: 'yuv420p',
    videoCodec: 'h264',
    audioCodec: 'aac',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 10,
    ...over
  }
}

describe('视频显示方向与目标尺寸', () => {
  it.each([
    [media({ width: 1920, height: 1080 }), { width: 1920, height: 1080 }, { width: 1920, height: 1080 }],
    [media({ width: 1080, height: 1920 }), { width: 1080, height: 1920 }, { width: 1080, height: 1920 }],
    [media({ width: 1080, height: 1080 }), { width: 1080, height: 1080 }, { width: 1080, height: 1920 }],
    [media({ width: 1080, height: 1920, rotation: 90 }), { width: 1920, height: 1080 }, { width: 1920, height: 1080 }],
    [media({ width: 1920, height: 1080, rotation: -90 }), { width: 1080, height: 1920 }, { width: 1080, height: 1920 }]
  ])('按旋转后的显示尺寸分类', (probe, display, target) => {
    expect(displayDimensions(probe)).toEqual(display)
    expect(targetDimensions(probe)).toEqual(target)
  })

  it('宽高未知时不猜测目标尺寸', () => {
    const probe = media({ width: 0, height: 0 })
    expect(displayDimensions(probe)).toBeNull()
    expect(targetDimensions(probe)).toBeNull()
  })
})

describe('无需转码判定', () => {
  it('目标尺寸、无旋转、H.264、MP4、yuv420p、方形像素且AAC音频时可跳过', () => {
    expect(isAlreadyCompatible(media())).toBe(true)
    expect(isAlreadyCompatible(media({ width: 1080, height: 1920, audioCodec: null }))).toBe(true)
  })

  it.each([
    ['旋转元数据', { rotation: 90 }],
    ['尺寸不符', { width: 1280, height: 720 }],
    ['视频编码不符', { videoCodec: 'hevc' }],
    ['像素格式不符', { pixelFormat: 'yuv444p' }],
    ['像素宽高比不符', { sampleAspectRatio: '4:3' }],
    ['容器不符', { formatName: 'matroska,webm' }],
    ['音频编码不符', { audioCodec: 'opus' }]
  ])('%s时必须转码', (_label, over) => {
    expect(isAlreadyCompatible(media(over))).toBe(false)
  })
})

describe('无拉伸滤镜图', () => {
  it.each([[1920, 1080, 480, 270], [1080, 1920, 270, 480]])(
    '%dx%d 使用低分辨率模糊背景和完整前景', (width, height, bgWidth, bgHeight) => {
      const filter = buildNormalizationFilter({ width, height })
      expect(filter).toContain('split=2[bg0][fg0]')
      expect(filter).toContain(`scale=${bgWidth}:${bgHeight}:force_original_aspect_ratio=increase`)
      expect(filter).toContain(`crop=${bgWidth}:${bgHeight}`)
      expect(filter).toContain('gblur=sigma=20')
      expect(filter).toContain(`scale=${width}:${height}[bg]`)
      expect(filter).toContain(`scale=${width}:${height}:force_original_aspect_ratio=decrease`)
      expect(filter).toContain('overlay=(W-w)/2:(H-h)/2')
      expect(filter).toContain('setsar=1')
      expect(filter).toContain('format=yuv420p[v]')
      expect(filter).not.toContain(`scale=${width}:${height}[fg]`)
    }
  )
})

describe('ffprobe 媒体解析', () => {
  it('解析视频、音频、时长和 side_data 旋转', async () => {
    const execFile = vi.fn((_file: string, _args: string[], cb: (error: Error | null, stdout: string) => void) => {
      cb(null, JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920,
            pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1',
            side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
          },
          { codec_type: 'audio', codec_name: 'aac' }
        ],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345' }
      }))
    })

    await expect(probeMedia('input.mp4', {
      findFfprobe: () => 'C:/ffmpeg/bin/ffprobe.exe',
      execFile
    })).resolves.toEqual(media({
      width: 1080,
      height: 1920,
      rotation: -90,
      durationSec: 12.345
    }))
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile.mock.calls[0][1]).toContain('-show_entries')
  })

  it('兼容 tags.rotate；找不到ffprobe、坏JSON或无有效视频流时返回null', async () => {
    const tagged = vi.fn((_file: string, _args: string[], cb: (error: Error | null, stdout: string) => void) => {
      cb(null, JSON.stringify({
        streams: [{
          codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
          pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', tags: { rotate: '180' }
        }],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3' }
      }))
    })
    await expect(probeMedia('tagged.mp4', { findFfprobe: () => 'ffprobe', execFile: tagged }))
      .resolves.toMatchObject({ rotation: 180, audioCodec: null })

    const never = vi.fn()
    await expect(probeMedia('missing.mp4', { findFfprobe: () => null, execFile: never }))
      .resolves.toBeNull()
    expect(never).not.toHaveBeenCalled()

    const badJson = vi.fn((_f: string, _a: string[], cb: (error: Error | null, stdout: string) => void) => cb(null, '{'))
    await expect(probeMedia('bad.mp4', { findFfprobe: () => 'ffprobe', execFile: badJson }))
      .resolves.toBeNull()

    const noVideo = vi.fn((_f: string, _a: string[], cb: (error: Error | null, stdout: string) => void) => {
      cb(null, JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} }))
    })
    await expect(probeMedia('audio.mp4', { findFfprobe: () => 'ffprobe', execFile: noVideo }))
      .resolves.toBeNull()
  })
})
