// src/main/ai/organizer-ai.ts — 按作者判定品类（"听+看"多模态）
//
// 一条作者主页的一批样本视频，转写每条的语音 → 抽几帧画面 →
// 拼成多模态 prompt（昵称+标题+转写+帧图）→ 交给 Analyzer.classifyWithMedia
// 得到该作者的整体品类。作者主页转写费用低、画面信息高，视听并用判断更准。
//
// 失败全部静默回退成 null —— 上层（Task 14 的 Organizer 集成）拿到 null
// 就走文字分类或保持未分类，不会因为单条作者判定失败而中断整理。

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Analyzer } from '../analyzer'
import type { Transcript } from '../asr/asr'
import { extractFrames } from '../asr/media'
import type { AuthorRow, VideoRow } from '../../shared/types'

/** classifyAuthor 需要的全部依赖。缺哪样都会让结果变成 null */
export interface ClassifyDeps {
  analyzer: Analyzer | null
  asr: { transcribeFor: (row: VideoRow) => Promise<Transcript> } | null
  ffmpeg: string | null
  /** 每条样本抽几帧；默认 4 */
  framesCount?: number
  /** 最多取几条样本；默认 3 */
  samplesCount?: number
}

// 帧 base64 总量上限。base64 会比原图涨 1/3，超了硬发出去只会在超时/413 上浪费等待。
// 抽帧数固定时一般到不了这数，但极端场景（超高清截图、抽帧失败重试）需要提前拦。
const MAX_FRAME_B64 = 8 * 1024 * 1024

/**
 * 用样本视频判定一个作者的品类。
 * 成功返回品类字符串；任何一步失败或依赖缺失都返回 null（上层自行回退）。
 * 转写失败、抽帧失败都只跳过该样本 —— 有一条能用的就继续试。
 */
export async function classifyAuthor(
  author: AuthorRow,
  samples: VideoRow[],
  deps: ClassifyDeps
): Promise<string | null> {
  // analyzer/asr/ffmpeg 任一不可用都没法视听判定，直接放弃让上层回退文字分类
  if (!deps.analyzer || !deps.asr || !deps.ffmpeg) return null

  const framesCount = deps.framesCount ?? 4
  const rows = samples.slice(0, deps.samplesCount ?? 3)
  if (rows.length === 0) return null

  // 临时帧目录：extractFrames 落盘的地方，用完即删
  const frameDir = await mkdtemp(join(tmpdir(), 'org-frames-'))
  const images: Array<{ dataUrl: string }> = []
  const lines: string[] = [`作者昵称：${author.nickname}`]
  let frameB64 = 0

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      lines.push(`\n样本${i + 1}：${row.title || '无标题'}`)

      // 1) 转写语音。单条失败只丢这条样本的语音信息，不影响整体
      let t: Transcript | null = null
      try {
        t = await deps.asr.transcribeFor(row)
      } catch { /* 转写失败：这条没有语音信息 */ }

      if (t) {
        // 纯背景音乐会硬编一段话，judge 已给可信度 —— 低可信时明确标注，别让模型误当人声
        const note = t.likelySpeech ? '' : ' [无语音·纯背景声]'
        lines.push(`转写：${t.text || '（未识别到说话内容）'}${note}`)
      } else {
        lines.push('转写：（转写失败，无语音信息）')
      }

      // 2) 抽几帧画面。每样本独立目录，避免帧文件名撞车互相覆盖
      if (row.local_path) {
        try {
          const files = await extractFrames(deps.ffmpeg, row.local_path, join(frameDir, String(i)), { count: framesCount })
          for (const f of files) {
            const b64 = (await readFile(f)).toString('base64')
            frameB64 += b64.length
            // 提前拦：总量超上限直接放弃视觉判定，别把请求打到超时才被发现
            if (frameB64 > MAX_FRAME_B64) {
              console.warn(`[organizer-ai] ${author.nickname} 帧 base64 总量超上限，放弃视觉判定`)
              return null
            }
            images.push({ dataUrl: `data:image/jpeg;base64,${b64}` })
          }
        } catch {
          // 单样本抽帧失败不影响整体；extractFrames 内部单帧失败已跳过
        }
      }
    }

    try {
      const result = await deps.analyzer.classifyWithMedia(
        lines.join('\n'),
        images,
        `author:${author.sec_uid}`
      )
      return result.category
    } catch {
      return null
    }
  } finally {
    // 临时帧目录用完即删：一批几百个作者下来占不了几个 G 就够了
    await rm(frameDir, { recursive: true, force: true }).catch(() => {})
  }
}
