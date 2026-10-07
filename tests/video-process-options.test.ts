import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildNormalizationArgs, isGoodEnough, normalizeVideo, probeMedia, targetDimensions,
  type MediaProbe, type VideoNormalizerDeps, type NormalizeVideoRequest, type NormalizeVideoResult
} from '../src/main/videoNormalizer'
import { VideoProcessor, scanVideoFiles, PROCESSED_DIR_NAME } from '../src/main/videoProcessor'

// 2026-10-07 视频处理改进（功能 D / O07）：
// ① 判定分两档：默认「尺寸对、剪辑软件能打开」就跳过（HEVC 1080×1920 不再重转）；「严格 H.264」才要求全部达标
// ② 转码码率不超过原片的 1.2 倍（以前 CRF 20 没上限，体积变大 3～4 倍）
// ③ 默认输出到「已处理」文件夹，原片不动、不改名
// ④ 可以强制竖屏 / 横屏

function media(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    width: 1080, height: 1920, rotation: 0, sampleAspectRatio: '1:1', pixelFormat: 'yuv420p',
    videoCodec: 'h264', audioCodec: 'aac', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', durationSec: 10, ...over
  }
}
function deps(source: MediaProbe, over: Partial<VideoNormalizerDeps> = {}): VideoNormalizerDeps {
  return {
    findFfmpeg: () => 'ffmpeg',
    probeMedia: vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(media({ durationSec: source.durationSec })),
    runFfmpeg: vi.fn().mockResolvedValue(undefined),
    fileSize: () => 4096,
    removeFile: vi.fn(),
    ...over
  }
}

describe('① 判定分两档', () => {
  it('默认：HEVC、yuv420p10、尺寸已经是 1080×1920 → 剪辑软件能打开，跳过', async () => {
    const src = media({ videoCodec: 'hevc', pixelFormat: 'yuv420p10le' })
    expect(isGoodEnough(src, { width: 1080, height: 1920 })).toBe(true)
    const d = deps(src)
    const r = await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4' }, d)
    expect(r.status).toBe('skipped')
    expect(d.runFfmpeg).not.toHaveBeenCalled()
  })

  it('严格 H.264：同一个 HEVC 文件要转', async () => {
    const d = deps(media({ videoCodec: 'hevc' }))
    const r = await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4', strict: true }, d)
    expect(r.status).toBe('normalized')
    expect(d.runFfmpeg).toHaveBeenCalledOnce()
  })

  it('尺寸不对、像素不是方的、剪辑软件不认的编码 → 默认也要转', () => {
    const t = { width: 1080, height: 1920 }
    expect(isGoodEnough(media({ width: 720, height: 1280 }), t)).toBe(false)
    expect(isGoodEnough(media({ sampleAspectRatio: '4:3' }), t)).toBe(false)
    expect(isGoodEnough(media({ videoCodec: 'vp9' }), t)).toBe(false)
    expect(isGoodEnough(media({ formatName: 'matroska,webm' }), t)).toBe(false)
  })
})

describe('② 码率上限', () => {
  it('知道原片码率：最高 1.2 倍（-maxrate / -bufsize）', () => {
    const args = buildNormalizationArgs('in.mp4', 'out.mp4', { width: 1080, height: 1920 }, { maxBitrate: 2_400_000 })
    expect(args.slice(args.indexOf('-maxrate'), args.indexOf('-maxrate') + 4)).toEqual(['-maxrate', '2400k', '-bufsize', '4800k'])
  })
  it('不知道原片码率：不加上限', () => {
    expect(buildNormalizationArgs('in.mp4', 'out.mp4', { width: 1080, height: 1920 })).not.toContain('-maxrate')
  })
  it('转码时按原片码率 × 1.2 传给 FFmpeg（太低的原片至少给 800k，不然画面糊）', async () => {
    const d = deps(media({ width: 720, height: 1280, bitRate: 2_000_000 }))
    await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4' }, d)
    const args = (d.runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(args[args.indexOf('-maxrate') + 1]).toBe('2400k')
    const low = deps(media({ width: 720, height: 1280, bitRate: 300_000 }))
    await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4' }, low)
    const lowArgs = (low.runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(lowArgs[lowArgs.indexOf('-maxrate') + 1]).toBe('800k')
  })
  it('ffprobe 读出容器码率', async () => {
    const execFile = (_f: string, _a: string[], cb: (e: Error | null, out: string) => void) => cb(null, JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1' }],
      format: { format_name: 'mov,mp4', duration: '5', bit_rate: '1834567' }
    }))
    expect((await probeMedia('x.mp4', { findFfprobe: () => 'ffprobe', execFile }))?.bitRate).toBe(1834567)
  })
})

describe('音频', () => {
  it('原片音频是 AAC → 直接复制；不是 → 转 AAC 192k', async () => {
    const aac = deps(media({ width: 720, height: 1280 }))
    await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4' }, aac)
    const a = (aac.runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(a.slice(a.indexOf('-c:a'), a.indexOf('-c:a') + 2)).toEqual(['-c:a', 'copy'])
    const opus = deps(media({ width: 720, height: 1280, audioCodec: 'opus' }))
    await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4' }, opus)
    const o = (opus.runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
    expect(o.slice(o.indexOf('-c:a'), o.indexOf('-c:a') + 4)).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })
})

describe('④ 强制竖屏 / 横屏', () => {
  it('横屏原片选「竖屏」→ 目标 1080×1920，并且要转', async () => {
    const src = media({ width: 1920, height: 1080 })
    expect(targetDimensions(src, 'portrait')).toEqual({ width: 1080, height: 1920 })
    expect(targetDimensions(media(), 'landscape')).toEqual({ width: 1920, height: 1080 })
    expect(targetDimensions(src)).toEqual({ width: 1920, height: 1080 }) // 默认按原片方向
    const d = deps(src, { probeMedia: vi.fn().mockResolvedValueOnce(src).mockResolvedValueOnce(media()) })
    const r = await normalizeVideo({ inputPath: 'a.mp4', outputPath: 'o.mp4', orientation: 'portrait' }, d)
    expect(r).toMatchObject({ status: 'normalized', target: { width: 1080, height: 1920 } })
  })
})

describe('③ 输出到「已处理」文件夹（原片不动）', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'vp-opt-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })
  const put = (rel: string, content = 'SRC'.repeat(1000)): string => {
    const p = join(tmp, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); return p
  }
  const V = { width: 1080, height: 1920 }
  const fake = (calls: NormalizeVideoRequest[]) => async (req: NormalizeVideoRequest): Promise<NormalizeVideoResult> => {
    calls.push(req)
    if (req.inputPath.endsWith('ok.mp4')) return { status: 'skipped', target: V, source: V }
    writeFileSync(req.outputPath, 'OUT'.repeat(500))
    return { status: 'normalized', target: V, source: { width: 720, height: 1280 } }
  }

  it('结果放进 <所选文件夹>/已处理/ 下对应的子文件夹；原片原名原样留着，不产生 .original.mp4；记下前后大小', async () => {
    const a = put('美食/a.mp4')
    put('ok.mp4')
    const calls: NormalizeVideoRequest[] = []
    const vp = new VideoProcessor({ normalize: fake(calls) })
    expect(vp.start(tmp, { mode: 'folder' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(vp.getState().phase).toBe('finished'))
    const out = join(tmp, PROCESSED_DIR_NAME, '美食', 'a.mp4')
    expect(readFileSync(out, 'utf8')).toBe('OUT'.repeat(500))
    expect(readFileSync(a, 'utf8')).toBe('SRC'.repeat(1000))
    expect(existsSync(join(tmp, '美食', 'a.original.mp4'))).toBe(false)
    const s = vp.getState()
    expect(s.outputDir).toBe(join(tmp, PROCESSED_DIR_NAME))
    expect(s.items.find(i => i.name === 'a.mp4')).toMatchObject({ status: 'done', sizeBefore: 3000, sizeAfter: 1500 })
    expect(s.items.find(i => i.name === 'ok.mp4')?.status).toBe('skipped')
  })

  it('「已处理」文件夹里的不再当成待处理；已经处理过（结果已存在）的跳过', async () => {
    put('a.mp4')
    put('b.mp4')
    put(`${PROCESSED_DIR_NAME}/b.mp4`, 'OLD')
    expect(scanVideoFiles(tmp).some(p => p.includes(PROCESSED_DIR_NAME))).toBe(false)
    const calls: NormalizeVideoRequest[] = []
    const vp = new VideoProcessor({ normalize: fake(calls) })
    vp.start(tmp, { mode: 'folder' })
    await vi.waitFor(() => expect(vp.getState().phase).toBe('finished'))
    expect(vp.getState().total).toBe(2)
    expect(calls.map(c => c.inputPath.replace(/\\/g, '/').split('/').pop())).toEqual(['a.mp4'])
    expect(vp.getState().items.find(i => i.name === 'b.mp4')?.status).toBe('skipped')
    expect(readFileSync(join(tmp, PROCESSED_DIR_NAME, 'b.mp4'), 'utf8')).toBe('OLD')
  })

  it('严格 H.264、强制方向传给转码', async () => {
    put('a.mp4')
    const calls: NormalizeVideoRequest[] = []
    const vp = new VideoProcessor({ normalize: fake(calls) })
    vp.start(tmp, { mode: 'folder', strict: true, orientation: 'portrait' })
    await vi.waitFor(() => expect(vp.getState().phase).toBe('finished'))
    expect(calls[0]).toMatchObject({ strict: true, orientation: 'portrait' })
  })
})
