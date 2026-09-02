import { execFile } from 'node:child_process'
import { findBin } from './ffbin'

export type VideoDimensions = { width: number; height: number }

export function screenBucket(width: number, height: number): '竖屏' | '横屏' | '未识别' {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '未识别'
  return height >= width ? '竖屏' : '横屏'
}

export interface ProbeDeps {
  findFfprobe: () => string | null
  execFile: (file: string, args: string[], callback: (error: Error | null, stdout: string) => void) => void
}

const realDeps: ProbeDeps = {
  findFfprobe: () => findBin('ffprobe'),
  execFile: (file, args, callback) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, callback)
  }
}

/** 复用随包 ffprobe 探测第一条视频流；找不到工具、坏文件或超时都降级为未知。 */
export async function probeVideoDimensions(file: string, deps: ProbeDeps = realDeps): Promise<VideoDimensions | null> {
  const ffprobe = deps.findFfprobe()
  if (!ffprobe) return null
  return new Promise(resolve => {
    try {
      deps.execFile(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'json', file
      ], (error, stdout) => {
        if (error) { resolve(null); return }
        try {
          const data = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }
          const width = Number(data.streams?.[0]?.width ?? 0)
          const height = Number(data.streams?.[0]?.height ?? 0)
          resolve(screenBucket(width, height) === '未识别' ? null : { width, height })
        } catch { resolve(null) }
      })
    } catch { resolve(null) }
  })
}
