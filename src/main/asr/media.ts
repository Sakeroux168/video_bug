// src/main/asr/media.ts — ffmpeg 抽音轨/抽帧封装（ASR 预处理）
//
// 照搬 ainame 的 src/lib/media.js 的 extractAudio/extractFrames，去掉 GPU 分支，
// 改为 TypeScript。两个用途：
//   1. extractAudio：视频 → 16kHz 单声道 PCM wav，喂语音识别
//   2. extractFrames：均匀抽几帧 jpg，喂视觉模型
//
// 并发闸门：ffmpeg 是 CPU 密集型，不限流的话几个并发就能把 CPU 打满、
// 界面跟着卡。这里用轻量信号量（抽音轨/抽帧各一个）做限流，不引第三方依赖。
//
// 这个文件不 import electron，主进程和普通 Node 测试都能跑。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findBin } from '../ffbin'

const execFileAsync = promisify(execFile)

// ffmpeg 单实例 CPU 占用高，同一时刻最多跑两个（音轨/抽帧各有各的闸门）
const FFMPEG_CONCURRENCY = 2

// ==========================
// 定位 ffmpeg
// ==========================

/** 在常见路径/PATH 里找 ffmpeg（各盘符 /123 下的 ffmpeg 目录的 bin 里）。找不到返回 null */
export function findFfmpeg(): string | null {
  return findBin('ffmpeg')
}

// ==========================
// 轻量并发闸门
// ==========================
// 最小可用的信号量：run() 里跑的任务并发不超过 max，超出排队。
//
// 计数约定：active 只数"正在跑的任务"，不数排队者。经典信号量写法 ——
//   · acquire：有空位 → active++ 直接进场；没空位 → 只把 resolve 排队，不计数。
//   · release：有排队者 → 唤醒队首，名额直接交接（active 不变，仍满员）；
//              没排队者 → active-- 让出空位。
// 注意不要把 active++ 写进排队的回调里 —— 那样每交接一次计数就净 +1，
// 一批任务跑完 active 会停在满员值而实际无人运行，之后 acquire 全部挂起死锁。

export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    return new Promise(resolve => {
      if (this.active < this.max) {
        this.active++
        resolve()
      } else {
        // 满员就排队；release 时唤醒队首，名额直接交接
        this.queue.push(resolve)
      }
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next() // 有等待者：名额让给它（active 不变，保持满员）
    else this.active--
  }
}

const audioSem = new Semaphore(FFMPEG_CONCURRENCY)
const frameSem = new Semaphore(FFMPEG_CONCURRENCY)

// ==========================
// 原子写
// ==========================
// 一律先写 .part 再改名。不这么做的话，写到一半被中断会留下残缺文件，
// 下次"文件存在"的判断会以为它是好的，于是永远不会重新生成。

async function atomicOutput(destPath: string, fn: (tmp: string) => Promise<unknown>): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  const tmp = destPath + '.part'
  try {
    await fn(tmp)
    await rename(tmp, destPath)
  } catch (e) {
    try { await unlink(tmp) } catch { /* .part 可能没生成，不碍事 */ }
    throw e
  }
}

// ==========================
// 抽音轨
// ==========================
// 16kHz 单声道 PCM wav —— 大多数语音识别的标准输入格式。

export interface ExtractAudioOpts {
  /** 只转前 N 秒。给超长视频用 —— 转写一小时既慢又没必要，取开头几分钟通常就够 */
  maxSec?: number
}

export async function extractAudio(
  ffmpeg: string,
  src: string,
  dest: string,
  opts: ExtractAudioOpts = {}
): Promise<void> {
  const { maxSec = 0 } = opts
  if (!Number.isFinite(maxSec) || maxSec < 0) {
    throw new Error(`extractAudio: maxSec 必须是非负有限数值，收到 ${maxSec}`)
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-vn',                    // 丢掉视频轨
    '-ac', '1',               // 单声道
    '-ar', '16000',           // 16kHz
    '-c:a', 'pcm_s16le'
  ]
  if (maxSec > 0) args.push('-t', String(maxSec))

  await audioSem.run(() => atomicOutput(dest, tmp =>
    execFileAsync(ffmpeg, [...args, '-f', 'wav', '-y', tmp])
  ))
}

// ==========================
// 抽帧
// ==========================
// 均匀抽 count 帧喂视觉模型。避开首尾各 5% —— 那里常是黑屏、片头动画、
// 片尾引导关注，抽到等于白花钱还会把模型带偏。

export interface ExtractFramesOpts {
  /** 抽多少帧；默认 4 */
  count?: number
  /** 输出高度（宽度按比例缩放并取偶）；默认 192 */
  height?: number
}

/** 用同目录的 ffprobe 读视频时长（秒）。读不到返回 0（抽帧会退化成失败前报错） */
async function probeDuration(ffmpeg: string, src: string): Promise<number> {
  // ffmpeg 和 ffprobe 同目录，把文件名换掉即可
  const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration',
      src
    ])
    const data = JSON.parse(stdout) as { format?: { duration?: string } }
    const dur = Number(data.format?.duration ?? 0)
    return Number.isFinite(dur) && dur > 0 ? dur : 0
  } catch { return 0 }
}

export async function extractFrames(
  ffmpeg: string,
  src: string,
  destDir: string,
  opts: ExtractFramesOpts = {}
): Promise<string[]> {
  const { count = 4, height = 192 } = opts
  if (!Number.isInteger(count) || count <= 0 || count > 100) {
    throw new Error(`extractFrames: count 必须是 1-100 的整数，收到 ${count}`)
  }
  if (!Number.isInteger(height) || height <= 0 || height > 4096) {
    throw new Error(`extractFrames: height 必须是 1-4096 的整数，收到 ${height}`)
  }

  await mkdir(destDir, { recursive: true })

  // 需要时长才能把归一化比例换算成绝对时间点；读不到就整批报错
  const dur = await probeDuration(ffmpeg, src)
  if (dur <= 0) throw new Error(`无法读取视频时长，无法抽帧: ${src}`)

  const results: string[] = []

  for (let i = 0; i < count; i++) {
    // 避开首尾各 5%：那里常是黑屏、片头动画和片尾引导关注
    const ratio = 0.05 + (0.9 * (i + 0.5)) / count
    const at = Math.max(0, dur * ratio)
    const out = join(destDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`)

    try {
      await frameSem.run(() => execFileAsync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        // -ss 放 -i 前面是关键帧快速定位，几乎不耗时
        '-ss', at.toFixed(3),
        '-i', src,
        '-frames:v', '1',
        // -2 保证宽度是偶数，否则某些编码器会拒绝
        '-vf', `scale=-2:${height}`,
        '-q:v', '3',
        '-f', 'image2',
        '-y',
        out
      ]))
      results.push(out)
    } catch (e) {
      // 单帧失败不影响整体：少一帧模型照样能判断内容。整批失败才是真问题。
      console.warn(`[media] 抽帧 ${i + 1}/${count} 失败: ${(e as Error).message}`)
    }
  }

  if (results.length === 0) {
    throw new Error(`所有帧都抽取失败: ${src}`)
  }

  return results
}
