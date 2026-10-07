import { describe, expect, it, vi } from 'vitest'
import {
  buildNormalizationArgs,
  buildNormalizationFilter,
  displayDimensions,
  isAlreadyCompatible,
  normalizeVideo,
  probeMedia,
  targetDimensions,
  type MediaProbe,
  type VideoNormalizerDeps
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

function normalizerDeps(over: Partial<VideoNormalizerDeps> = {}): VideoNormalizerDeps {
  return {
    findFfmpeg: () => 'C:/ffmpeg/bin/ffmpeg.exe',
    probeMedia: vi.fn()
      .mockResolvedValueOnce(media({ width: 1280, height: 720 }))
      .mockResolvedValueOnce(media()),
    runFfmpeg: vi.fn().mockResolvedValue(undefined),
    fileSize: () => 2048,
    removeFile: vi.fn(),
    ...over
  }
}

describe('FFmpeg 标准化编排', () => {
  it('已完全兼容时跳过转码，即使本机没有ffmpeg也可直接使用原片', async () => {
    const deps = normalizerDeps({
      findFfmpeg: () => null,
      probeMedia: vi.fn().mockResolvedValue(media()),
      runFfmpeg: vi.fn()
    })
    const result = await normalizeVideo({ inputPath: 'source.mp4', outputPath: 'normalized.part.mp4' }, deps)
    expect(result).toMatchObject({ status: 'skipped', target: { width: 1920, height: 1080 } })
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
  })

  it('媒体无法探测或ffmpeg缺失时返回可区分失败，不创建输出', async () => {
    const noProbe = normalizerDeps({ probeMedia: vi.fn().mockResolvedValue(null) })
    await expect(normalizeVideo({ inputPath: 'source.mp4', outputPath: 'out.mp4' }, noProbe))
      .resolves.toEqual({ status: 'failed', error: 'media_probe_failed' })
    expect(noProbe.runFfmpeg).not.toHaveBeenCalled()

    const noFfmpeg = normalizerDeps({ findFfmpeg: () => null })
    await expect(normalizeVideo({ inputPath: 'source.mp4', outputPath: 'out.mp4' }, noFfmpeg))
      .resolves.toMatchObject({ status: 'failed', error: 'ffmpeg_not_found' })
    expect(noFfmpeg.runFfmpeg).not.toHaveBeenCalled()
  })

  it('横屏使用libx264可靠参数、可选音轨映射和无拉伸滤镜，验证后返回normalized', async () => {
    const deps = normalizerDeps()
    const result = await normalizeVideo({ inputPath: 'source.mp4', outputPath: 'normalized.part.mp4' }, deps)
    expect(result).toMatchObject({ status: 'normalized', target: { width: 1920, height: 1080 } })
    expect(deps.runFfmpeg).toHaveBeenCalledOnce()
    const [exe, args] = vi.mocked(deps.runFfmpeg).mock.calls[0]
    expect(exe).toBe('C:/ffmpeg/bin/ffmpeg.exe')
    // 需求变更（2026-10-07 视频处理改进）：原片音频已是 AAC 时直接复制，不再重编码成 192k（体积会涨）
    expect(args).toEqual(buildNormalizationArgs('source.mp4', 'normalized.part.mp4', { width: 1920, height: 1080 }, { copyAudio: true }))
    expect(args).toContain('libx264')
    expect(args).toContain('medium')
    expect(args).toContain('20')
    expect(args).toContain('0:a:0?')
    expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2)).toEqual(['-c:a', 'copy'])
    expect(args).toContain('+faststart')
    expect(args.join(' ')).toContain('force_original_aspect_ratio=decrease')
  })

  it('结果带源显示尺寸；onProbe 在探测完、开始转码前回调一次（视频处理页据此在转码中就能显示尺寸）', async () => {
    const order: string[] = []
    const onProbe = vi.fn(() => { order.push('probe') })
    const deps = normalizerDeps({
      probeMedia: vi.fn()
        .mockResolvedValueOnce(media({ width: 720, height: 1280, rotation: 90 })) // 旋转后显示为 1280×720 横屏
        .mockResolvedValueOnce(media()),
      runFfmpeg: vi.fn(async () => { order.push('ffmpeg') })
    })
    const result = await normalizeVideo({ inputPath: 'rot.mp4', outputPath: 'out.mp4', onProbe }, deps)
    expect(onProbe).toHaveBeenCalledWith({ source: { width: 1280, height: 720 }, target: { width: 1920, height: 1080 } })
    expect(order).toEqual(['probe', 'ffmpeg'])
    expect(result).toMatchObject({ status: 'normalized', source: { width: 1280, height: 720 }, target: { width: 1920, height: 1080 } })

    const skipped = await normalizeVideo({ inputPath: 'ok.mp4', outputPath: 'out.mp4' }, normalizerDeps({ probeMedia: vi.fn().mockResolvedValue(media()) }))
    expect(skipped).toMatchObject({ status: 'skipped', source: { width: 1920, height: 1080 } })

    const noProbe = vi.fn()
    await normalizeVideo({ inputPath: 'bad.mp4', outputPath: 'out.mp4', onProbe: noProbe }, normalizerDeps({ probeMedia: vi.fn().mockResolvedValue(null) }))
    expect(noProbe).not.toHaveBeenCalled() // 探测失败没有尺寸可报
  })

  it('无音轨输入正常标准化，输出也允许无音轨', async () => {
    const deps = normalizerDeps({
      probeMedia: vi.fn()
        .mockResolvedValueOnce(media({ width: 720, height: 1280, audioCodec: null }))
        .mockResolvedValueOnce(media({ width: 1080, height: 1920, audioCodec: null }))
    })
    await expect(normalizeVideo({ inputPath: 'silent.mp4', outputPath: 'out.mp4' }, deps))
      .resolves.toMatchObject({ status: 'normalized', target: { width: 1080, height: 1920 } })
  })

  it('进程失败清理半成品并返回ffmpeg_failed', async () => {
    const removeFile = vi.fn()
    const deps = normalizerDeps({
      runFfmpeg: vi.fn().mockRejectedValue(new Error('encoder failed')),
      removeFile
    })
    await expect(normalizeVideo({ inputPath: 'source.mp4', outputPath: 'out.mp4' }, deps))
      .resolves.toMatchObject({ status: 'failed', error: 'ffmpeg_failed' })
    expect(removeFile).toHaveBeenCalledWith('out.mp4')
  })

  it('取消信号返回aborted并清理半成品，不伪装成普通转码失败', async () => {
    const controller = new AbortController()
    const removeFile = vi.fn()
    const runFfmpeg = vi.fn(async (_exe: string, _args: string[], signal?: AbortSignal) => {
      controller.abort()
      expect(signal?.aborted).toBe(true)
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const deps = normalizerDeps({ runFfmpeg, removeFile })
    await expect(normalizeVideo({
      inputPath: 'source.mp4', outputPath: 'out.mp4', signal: controller.signal
    }, deps)).resolves.toMatchObject({ status: 'aborted' })
    expect(removeFile).toHaveBeenCalledWith('out.mp4')
  })

  it.each([
    ['文件过小', normalizerDeps({ fileSize: () => 10 })],
    ['输出无法探测', normalizerDeps({ probeMedia: vi.fn().mockResolvedValueOnce(media({ width: 1280, height: 720 })).mockResolvedValueOnce(null) })],
    ['输出尺寸错误', normalizerDeps({ probeMedia: vi.fn().mockResolvedValueOnce(media({ width: 1280, height: 720 })).mockResolvedValueOnce(media({ width: 1080, height: 1920 })) })],
    ['输出时长漂移', normalizerDeps({ probeMedia: vi.fn().mockResolvedValueOnce(media({ width: 1280, height: 720, durationSec: 10 })).mockResolvedValueOnce(media({ durationSec: 8 })) })]
  ])('%s时拒绝结果、清理半成品并返回output_invalid', async (_label, deps) => {
    await expect(normalizeVideo({ inputPath: 'source.mp4', outputPath: 'out.mp4' }, deps))
      .resolves.toMatchObject({ status: 'failed', error: 'output_invalid' })
    expect(deps.removeFile).toHaveBeenCalledWith('out.mp4')
  })
})
