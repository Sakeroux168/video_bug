// tests/asr.test.ts — ASR 转写编排（Task 12）
//
// 三层覆盖：
//   · meaningfulChars / judge 是纯函数，直接测；
//   · transcribeFor 用 vi.mock 顶掉 extractAudio（不真调 ffmpeg），
//     并靠 opts.runWorker 注入 mock 子进程（不真拉起 electron/node）。
// 编排两条路径都验：miss 跑 worker + 落库；同 aweme_id 二次调用命中缓存、worker 不重复跑。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb } from '../src/main/db'
import { meaningfulChars, judge, transcribeFor } from '../src/main/asr/asr'
import type { WorkerOutput } from '../src/main/asr/asr'

// extractAudio 换成假实现 —— 编排/缓存测试不该真调 ffmpeg。
// findFfmpeg 也用假值顶掉（transcribeFor 用 opts.ffmpeg，其实不依赖它）。
vi.mock('../src/main/asr/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/asr/media')>()
  return {
    ...actual,
    extractAudio: vi.fn(async () => {}),
    findFfmpeg: vi.fn(() => 'ffmpeg-mock')
  }
})

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'asr-test-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

// worker 假输出：内容够密，judge 应判 likelySpeech:true
const workerOutput: WorkerOutput = {
  text: '这是一段正常的说话内容，包含足够的文字信息，密度也够高。',
  totalSec: 30,
  speechSec: 20
}

const models = { model: '/m/model.onnx', tokens: '/m/tokens.txt', vad: '/m/vad.onnx' }

describe('meaningfulChars', () => {
  it('去空白 + 中英文标点后数实义字', () => {
    // '你好，世界！abc.' → 去，！. → 你好世界abc（共 7 字）
    expect(meaningfulChars('你好，世界！abc.')).toBe(7)
    expect(meaningfulChars('  你好  世界  ')).toBe(4)
    expect(meaningfulChars('a，b。c！d？')).toBe(4)
    expect(meaningfulChars('')).toBe(0)
    expect(meaningfulChars(null)).toBe(0)
  })
})

describe('judge', () => {
  it('正常文本 → likelySpeech:true', () => {
    const r = judge({ text: '这是一段正常的说话内容，包含足够的文字信息，密度也够高。', speechSec: 20, totalSec: 30 })
    expect(r.likelySpeech).toBe(true)
    expect(r.chars).toBeGreaterThanOrEqual(10)
    expect(r.density).toBeGreaterThanOrEqual(0.5)
  })

  it('稀疏低密度（纯背景音乐）→ likelySpeech:false 带原因', () => {
    // 11 个字铺在 60 秒里：密度 11/60 ≈ 0.18 < 0.5 → 判纯背景声
    const r = judge({ text: '嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯', speechSec: 60, totalSec: 60 })
    expect(r.likelySpeech).toBe(false)
    expect(r.reason.length).toBeGreaterThan(0)
    expect(r.reason).toContain('稀')
  })

  it('过短 → likelySpeech:false 带原因', () => {
    const r = judge({ text: '嗯', speechSec: 10, totalSec: 10 })
    expect(r.likelySpeech).toBe(false)
    expect(r.reason.length).toBeGreaterThan(0)
  })

  it('时长未知（老记录）只能按字数粗判 → 放宽为 true', () => {
    const r = judge({ text: '这是一段正常的内容文字', speechSec: 0, totalSec: 0 })
    expect(r.likelySpeech).toBe(true)
    expect(r.durationUnknown).toBe(true)
  })
})

describe('transcribeFor', () => {
  it('miss → 跑 worker + 落库；同 aweme_id 二次调用命中缓存、worker 不重复跑', async () => {
    const runWorker = vi.fn(async (): Promise<WorkerOutput> => ({ ...workerOutput }))
    const row = { aweme_id: 'AW1', local_path: join(dir, 'clip.mp4') }
    const opts = { ffmpeg: 'ffmpeg-mock', models, runWorker }

    const t1 = await transcribeFor(db, row, opts)
    expect(t1.fromCache).toBe(false)
    expect(t1.likelySpeech).toBe(true)
    expect(runWorker).toHaveBeenCalledTimes(1)

    const t2 = await transcribeFor(db, row, opts)
    expect(t2.fromCache).toBe(true)            // 缓存命中
    expect(runWorker).toHaveBeenCalledTimes(1) // worker 不重复跑
    expect(t2.text).toBe(t1.text)
    expect(t2.speechSec).toBe(t1.speechSec)

    // transcripts 只落一条，缓存 key 用 aweme_id
    const rows = db.prepare('SELECT * FROM transcripts').all() as Array<{ content_hash: string; text: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].content_hash).toBe('AW1')
    expect(rows[0].text).toBe(workerOutput.text)
  })

  it('请求参数写成 JSON 临时文件再交给 worker，用完即删', async () => {
    const seen: string[] = []
    const runWorker = vi.fn(async (reqFile: string): Promise<WorkerOutput> => {
      seen.push(reqFile)
      const req = JSON.parse(readFileSync(reqFile, 'utf8'))
      expect(req.wav).toBeTruthy() // wav 路径由 extractAudio 的 dest 填
      expect(req.model).toBe('/m/model.onnx')
      expect(req.tokens).toBe('/m/tokens.txt')
      expect(req.vad).toBe('/m/vad.onnx')
      expect(req.numThreads).toBe(4)
      expect(req.provider).toBe('cpu')
      return { ...workerOutput }
    })

    await transcribeFor(
      db,
      { aweme_id: 'AW2', local_path: join(dir, 'b.mp4') },
      { ffmpeg: 'ffmpeg-mock', models, runWorker }
    )

    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0])).toBe(false) // 临时请求文件用完即删
  })

  it('worker 非零退出 → rejection 消息带 stderr 首行诊断 + exit code', async () => {
    // 模拟子进程失败：promisify(execFile) 在 exitCode!=0 时会 reject 一个
    // 挂了 stderr / code 的 error（worker 的 fail() 把可读原因打在 stderr 首行）
    const runWorker = vi.fn(async (): Promise<WorkerOutput> => {
      const e = new Error('Command failed') as Error & { stderr?: string; code?: string }
      e.stderr = '语音转写子进程出错：加载识别模型失败\n原始错误：\n...'
      e.code = '1'
      throw e
    })

    let caught: Error | null = null
    try {
      await transcribeFor(
        db,
        { aweme_id: 'AW3', local_path: join(dir, 'c.mp4') },
        { ffmpeg: 'ffmpeg-mock', models, runWorker }
      )
    } catch (e) {
      caught = e as Error
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('加载识别模型失败') // stderr 首行的可读原因
    expect(caught!.message).toContain('code=1') // exit code 一并带上
  })
})
