import { execFile } from 'node:child_process'
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

