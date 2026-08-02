// src/main/asr/asr.ts — ASR 转写编排（缓存 + judge 可信度 + 子进程拉起）
//
// 照搬 ainame 的 src/asr/index.js 改为 TypeScript。它负责一整条转写流水线：
//   查缓存 → 抽音轨 → 写请求 JSON → 拉起子进程转写 → judge 可信度 → 落库 → 清理临时文件
//
// 这个文件不 import electron，主进程和普通 Node 测试都能跑。
// 子进程拉起通过 opts.runWorker 注入 —— 测试传 mock 就不用真拉起 electron/node。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { extractAudio } from './media'

const execFileAsync = promisify(execFile)

// judge 阈值（与 ainame defaults.js 的 ASR.MIN_CHARS / ASR.MIN_CHARS_PER_SEC 对齐）
const MIN_CHARS = 10
const MIN_CHARS_PER_SEC = 0.5

// 转写是整条流水线最慢的一步，给足 5 分钟；超时 execFile 会杀进程并抛错
const WORKER_TIMEOUT_MS = 300000

// 构建后 asr-worker.js 和主进程 bundle 同目录（out/main/）。
// import.meta.url 在 electron-vite 的 CJS 产物里会被 Rollup 转成对 __filename 的引用，
// 两种环境下都指到真实文件路径。
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'asr-worker.js')

// ==========================
// 结果可信度
// ==========================
// SenseVoice 遇到纯背景音乐不会返回空，而是硬编一段不存在的话。
// 所以转写结果不能直接用 —— 先按"实义字密度"判这条视频到底有没有人说话。

/** 只数实义字符。标点不算 —— ITN 打开后标点占比不低，算进去会把密度整体抬高，阈值就得跟着调 */
export function meaningfulChars(text: string | null | undefined): number {
  return String(text || '')
    .replace(/[\s　]/g, '')
    .replace(/[，。！？、；：""''《》（）,.!?;:"'()\[\]<>-]/g, '')
    .length
}

export interface JudgeInput {
  text: string
  speechSec: number
  totalSec: number
}

export interface JudgeResult {
  chars: number
  density: number
  likelySpeech: boolean
  reason: string
  /** 时长两列都缺失（历史老记录）时只能按字数粗判，密度算不出来 */
  durationUnknown?: boolean
}

/**
 * 判断转写结果可不可信。纯背景音乐会硬编一段话，判据：
 *   · 字数太少（<10）→ 几乎没有可用内容
 *   · 密度太低（<0.5 字/秒）→ 背景声
 * 密度优先按【语音时长】算 —— 一条 60 秒的视频只在最后 3 秒有人说话时，
 * 按总长算会误判成"没人说话"。
 */
export function judge(input: JudgeInput): JudgeResult {
  const text = input.text || ''
  const speechSec = input.speechSec || 0
  const totalSec = input.totalSec || 0

  const chars = meaningfulChars(text)

  // 时长未知时只能退回"字数下限"这一条，密度算不出来。
  // 这种情况只会出现在老库里还没有 speech_sec / total_sec 两列的历史记录上。
  const base = speechSec > 0.5 ? speechSec : (totalSec > 0.5 ? totalSec : 0)

  if (chars < MIN_CHARS) {
    return {
      chars,
      density: base > 0 ? chars / base : 0,
      likelySpeech: false,
      reason: `整条视频只识别出 ${chars} 个字，几乎没有可用的说话内容`
    }
  }

  if (base <= 0) {
    return { chars, density: 0, likelySpeech: true, reason: '', durationUnknown: true }
  }

  const density = chars / base

  if (density < MIN_CHARS_PER_SEC) {
    return {
      chars,
      density,
      likelySpeech: false,
      reason:
        `识别出来的文字太稀（${base.toFixed(1)} 秒里只有 ${chars} 个字），` +
        `这条视频很可能只有背景音乐没有人说话。`
    }
  }

  return { chars, density, likelySpeech: true, reason: '' }
}

// ==========================
// 类型
// ==========================

export interface Transcript {
  text: string
  speechSec: number
  totalSec: number
  likelySpeech: boolean
  fromCache: boolean
}

/** 转写子进程打到 stdout 的结果（worker 输出） */
export interface WorkerOutput {
  text: string
  totalSec?: number
  speechSec?: number
  provider?: string
  providerFellBack?: boolean
}

/** 子进程拉起器：吃请求 JSON 路径，返回转写输出。测试注入 mock 代替真实 execFile */
export type WorkerRunner = (reqFile: string, signal?: AbortSignal) => Promise<WorkerOutput>

async function runWorkerProcess(reqFile: string, signal?: AbortSignal): Promise<WorkerOutput> {
  // ELECTRON_RUN_AS_NODE 让 electron.exe 当成普通 Node 跑 worker 脚本；
  // 在普通 Node 里（测试/命令行）这个环境变量无害。
  // 注意 execFile 的超时参数名叫 timeout（毫秒），不是 timeoutMs。
  const { stdout } = await execFileAsync(
    process.execPath,
    [WORKER, reqFile],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: WORKER_TIMEOUT_MS,
      signal
    }
  )

  // 结果只有一行 JSON（worker 里的约定），取末行解析
  let out: WorkerOutput
  try {
    out = JSON.parse(String(stdout).trim().split('\n').pop() || '')
  } catch {
    throw new Error(`转写子进程的输出无法解析：${String(stdout).slice(0, 200)}`)
  }
  return out
}

// ==========================
// 缓存（transcripts 表）
// ==========================
// 缓存 key 用 aweme_id（任务的 row），转写是整条流水线最慢的一步，绝不重复转。

interface TranscriptRow {
  content_hash: string
  text: string
  speech_sec: number
  total_sec: number
  engine: string | null
  created_at: string | null
}

function readCache(db: DatabaseSync, awemeId: string): TranscriptRow | null {
  const row = db.prepare('SELECT * FROM transcripts WHERE content_hash = ?').get(awemeId)
  return (row as unknown as TranscriptRow | null) ?? null
}

function writeCache(
  db: DatabaseSync,
  awemeId: string,
  data: { text: string; speechSec: number; totalSec: number }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO transcripts (content_hash, text, speech_sec, total_sec, engine, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(awemeId, data.text, data.speechSec, data.totalSec, 'sense-voice-2024-07-17', new Date().toISOString())
}

function transcriptFromRow(row: TranscriptRow): Transcript {
  // 落库的是【原始转写文本 + 时长】，不带可信度结论 —— 阈值以后要调时不用重写历史记录，
  // 每次命中都拿同一份数据现算 judge
  const verdict = judge({ text: row.text, speechSec: row.speech_sec || 0, totalSec: row.total_sec || 0 })
  return {
    text: row.text,
    speechSec: row.speech_sec || 0,
    totalSec: row.total_sec || 0,
    likelySpeech: verdict.likelySpeech,
    fromCache: true
  }
}

// ==========================
// 转写
// ==========================

export interface TranscribeOpts {
  ffmpeg: string
  models: { model: string; tokens: string; vad: string }
  /** 只抽前 N 秒音轨；默认 90 */
  maxSec?: number
  signal?: AbortSignal
  /** 测试注入：用 mock 代替真实子进程拉起 */
  runWorker?: WorkerRunner
}

export async function transcribeFor(
  db: DatabaseSync,
  row: { aweme_id: string; local_path: string },
  opts: TranscribeOpts
): Promise<Transcript> {
  if (!row || !row.aweme_id) {
    throw new Error('视频记录不完整，缺少 aweme_id')
  }

  // 缓存命中直接返回（含 judge 结论），不重复抽音轨/拉子进程
  const cached = readCache(db, row.aweme_id)
  if (cached) return transcriptFromRow(cached)

  const runWorker = opts.runWorker ?? runWorkerProcess

  // 临时音轨 + 请求 JSON。都在系统临时目录，用 aweme_id + pid + 时间戳防撞名
  const wav = join(tmpdir(), `video-asr-${row.aweme_id}-${process.pid}-${Date.now()}.wav`)
  const reqFile = join(tmpdir(), `video-asr-req-${row.aweme_id}-${process.pid}-${Date.now()}.json`)

  try {
    // 抽音轨。maxSec 限长 —— 转写一小时既慢又没必要，取开头一段通常就够
    await extractAudio(opts.ffmpeg, row.local_path, wav, { maxSec: opts.maxSec ?? 90 })

    // 请求参数走临时文件而不是命令行：路径里有中文和空格是常态，
    // 走文件就不用操心任何一层的引号转义
    await writeFile(reqFile, JSON.stringify({
      wav,
      model: opts.models.model,
      tokens: opts.models.tokens,
      vad: opts.models.vad,
      numThreads: 4,
      provider: 'cpu'
    }), 'utf8')

    let out: WorkerOutput
    try {
      out = await runWorker(reqFile, opts.signal)
    } catch (e) {
      // 子进程非零退出（exitCode != 0）或超时被杀：execFile 把 stderr / code 挂在 error 上。
      // worker 的 fail() 会把可读原因打在 stderr 第一行（模型缺失/加载失败/请求文件缺失），
      // 不拼进消息的话用户只看到一句"命令执行失败"，完全不知道错在哪。
      const err = e as Error & { code?: unknown; stderr?: unknown }
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') throw e // 主动取消原样上抛，不掩盖成"失败"
      const firstLine = String(err.stderr ?? '').split('\n')[0].trim()
      const code = err.code != null ? ` (code=${String(err.code)})` : ''
      throw new Error(`语音转写失败${code}：${firstLine || err.message}`)
    }

    const text = out.text || ''
    const speechSec = out.speechSec || 0
    const totalSec = out.totalSec || 0
    const verdict = judge({ text, speechSec, totalSec })

    // 空文本也是有效缓存（确实没识别出东西），不该每次都重跑一遍
    writeCache(db, row.aweme_id, { text, speechSec, totalSec })

    return {
      text,
      speechSec,
      totalSec,
      likelySpeech: verdict.likelySpeech,
      fromCache: false
    }
  } finally {
    // 临时文件用完即删：请求 JSON 和抽出来的音轨都没缓存价值
    // （音轨随时能从原视频重新抽出来，留着的话一批几百条视频能占好几个 G）
    await unlink(reqFile).catch(() => {})
    await unlink(wav).catch(() => {})
  }
}
