import { execFile, spawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { findBin } from './ffbin'

export interface MediaProbe {
  width: number
  height: number
  rotation: number
  sampleAspectRatio: string | null
  pixelFormat: string | null
  videoCodec: string
  audioCodec: string | null
  formatName: string
  durationSec: number
}

export interface VideoSize {
  width: number
  height: number
}

export interface MediaProbeDeps {
  findFfprobe: () => string | null
  execFile: (file: string, args: string[], callback: (error: Error | null, stdout: string) => void) => void
}

export interface NormalizeVideoRequest {
  inputPath: string
  outputPath: string
  signal?: AbortSignal
}

export type NormalizeVideoResult =
  | { status: 'normalized'; target: VideoSize }
  | { status: 'skipped'; target: VideoSize }
  | { status: 'failed'; error: 'media_probe_failed' | 'ffmpeg_not_found' | 'ffmpeg_failed' | 'output_invalid'; target?: VideoSize }
  | { status: 'aborted'; target?: VideoSize }

export interface VideoNormalizerDeps {
  findFfmpeg: () => string | null
  probeMedia: (file: string) => Promise<MediaProbe | null>
  runFfmpeg: (file: string, args: string[], signal?: AbortSignal) => Promise<void>
  fileSize: (file: string) => number
  removeFile: (file: string) => void
}

const realProbeDeps: MediaProbeDeps = {
  findFfprobe: () => findBin('ffprobe'),
  execFile: (file, args, callback) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      callback(error, String(stdout))
    })
  }
}

function validDimension(value: unknown): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 0
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizedRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360
}

export function displayDimensions(probe: Pick<MediaProbe, 'width' | 'height' | 'rotation'>): VideoSize | null {
  const width = validDimension(probe.width)
  const height = validDimension(probe.height)
  if (!width || !height) return null
  const rotation = normalizedRotation(finiteNumber(probe.rotation))
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height }
}

export function targetDimensions(probe: Pick<MediaProbe, 'width' | 'height' | 'rotation'>): VideoSize | null {
  const display = displayDimensions(probe)
  if (!display) return null
  return display.height >= display.width
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 }
}

function isSquarePixel(value: string | null): boolean {
  if (!value) return false
  if (value === '1') return true
  const parts = value.split(/[:/]/)
  if (parts.length !== 2) return false
  const numerator = Number(parts[0])
  const denominator = Number(parts[1])
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 && numerator / denominator === 1
}

export function isAlreadyCompatible(probe: MediaProbe): boolean {
  const target = targetDimensions(probe)
  if (!target) return false
  return normalizedRotation(probe.rotation) === 0
    && probe.width === target.width
    && probe.height === target.height
    && probe.videoCodec.toLowerCase() === 'h264'
    && probe.pixelFormat?.toLowerCase() === 'yuv420p'
    && isSquarePixel(probe.sampleAspectRatio)
    && probe.formatName.toLowerCase().split(',').includes('mp4')
    && (probe.audioCodec === null || probe.audioCodec.toLowerCase() === 'aac')
}

/**
 * 主体完整等比装入；背景用同源画面在四分之一工作尺寸上铺满、裁中、模糊，再放大到目标画布。
 * 前景分支永远带 force_original_aspect_ratio=decrease，禁止直接拉伸到固定宽高。
 */
export function buildNormalizationFilter(target: VideoSize): string {
  const bgWidth = Math.floor(target.width / 4)
  const bgHeight = Math.floor(target.height / 4)
  return [
    '[0:v]split=2[bg0][fg0]',
    `[bg0]scale=${bgWidth}:${bgHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${bgWidth}:${bgHeight},gblur=sigma=20:steps=2,scale=${target.width}:${target.height}[bg]`,
    `[fg0]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]'
  ].join(';')
}

export function buildNormalizationArgs(inputPath: string, outputPath: string, target: VideoSize): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-filter_complex', buildNormalizationFilter(target),
    '-map', '[v]',
    '-map', '0:a:0?',
    '-sn', '-dn',
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-metadata:s:v:0', 'rotate=0',
    outputPath
  ]
}

function abortError(): Error {
  return Object.assign(new Error('FFmpeg aborted'), { name: 'AbortError' })
}

/** 只保留少量 stderr 供本地调试；上层只收到稳定错误码，不把文件路径写进数据库。 */
async function runFfmpegProcess(file: string, args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-4096)
    })
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (signal?.aborted) finish(abortError())
      else if (code === 0) finish()
      else finish(new Error(stderr || `FFmpeg exited with code ${String(code)}`))
    })
  })
}

const realNormalizerDeps: VideoNormalizerDeps = {
  findFfmpeg: () => findBin('ffmpeg'),
  probeMedia,
  runFfmpeg: runFfmpegProcess,
  fileSize: file => statSync(file).size,
  removeFile: file => { try { rmSync(file, { force: true }) } catch { /* best effort */ } }
}

function durationMatches(source: MediaProbe, output: MediaProbe): boolean {
  if (source.durationSec <= 0) return true
  const tolerance = Math.max(0.5, source.durationSec * 0.02)
  return Math.abs(source.durationSec - output.durationSec) <= tolerance
}

function validNormalizedOutput(
  source: MediaProbe,
  output: MediaProbe | null,
  target: VideoSize,
  size: number
): boolean {
  return size >= 1024
    && output !== null
    && output.width === target.width
    && output.height === target.height
    && isAlreadyCompatible(output)
    && durationMatches(source, output)
}

export async function normalizeVideo(
  request: NormalizeVideoRequest,
  deps: VideoNormalizerDeps = realNormalizerDeps
): Promise<NormalizeVideoResult> {
  const source = await deps.probeMedia(request.inputPath)
  if (!source) return { status: 'failed', error: 'media_probe_failed' }
  const target = targetDimensions(source)
  if (!target) return { status: 'failed', error: 'media_probe_failed' }
  if (isAlreadyCompatible(source)) return { status: 'skipped', target }
  const ffmpeg = deps.findFfmpeg()
  if (!ffmpeg) return { status: 'failed', error: 'ffmpeg_not_found', target }

  try {
    await deps.runFfmpeg(
      ffmpeg,
      buildNormalizationArgs(request.inputPath, request.outputPath, target),
      request.signal
    )
  } catch (error) {
    deps.removeFile(request.outputPath)
    if (request.signal?.aborted || (error as Error).name === 'AbortError') return { status: 'aborted', target }
    return { status: 'failed', error: 'ffmpeg_failed', target }
  }

  let size = 0
  try { size = deps.fileSize(request.outputPath) } catch { /* invalid output */ }
  const output = size >= 1024 ? await deps.probeMedia(request.outputPath) : null
  if (!validNormalizedOutput(source, output, target, size)) {
    deps.removeFile(request.outputPath)
    return { status: 'failed', error: 'output_invalid', target }
  }
  return { status: 'normalized', target }
}

export async function probeMedia(file: string, deps: MediaProbeDeps = realProbeDeps): Promise<MediaProbe | null> {
  const ffprobe = deps.findFfprobe()
  if (!ffprobe) return null
  return new Promise(resolve => {
    try {
      deps.execFile(ffprobe, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration',
        '-of', 'json',
        file
      ], (error, stdout) => {
        if (error) { resolve(null); return }
        try {
          const data = JSON.parse(stdout) as {
            streams?: Array<{
              codec_type?: string
              codec_name?: string
              width?: number
              height?: number
              pix_fmt?: string
              sample_aspect_ratio?: string
              tags?: { rotate?: string | number }
              side_data_list?: Array<{ rotation?: string | number }>
            }>
            format?: { format_name?: string; duration?: string | number }
          }
          const video = data.streams?.find(stream => stream.codec_type === 'video')
          const width = validDimension(video?.width)
          const height = validDimension(video?.height)
          const videoCodec = String(video?.codec_name ?? '')
          if (!video || !width || !height || !videoCodec) { resolve(null); return }
          const audio = data.streams?.find(stream => stream.codec_type === 'audio')
          const sideRotation = video.side_data_list?.find(side => side.rotation !== undefined)?.rotation
          const rotation = finiteNumber(sideRotation ?? video.tags?.rotate ?? 0)
          const duration = finiteNumber(data.format?.duration, 0)
          resolve({
            width,
            height,
            rotation,
            sampleAspectRatio: video.sample_aspect_ratio ? String(video.sample_aspect_ratio) : null,
            pixelFormat: video.pix_fmt ? String(video.pix_fmt) : null,
            videoCodec,
            audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
            formatName: String(data.format?.format_name ?? ''),
            durationSec: duration >= 0 ? duration : 0
          })
        } catch {
          resolve(null)
        }
      })
    } catch {
      resolve(null)
    }
  })
}
