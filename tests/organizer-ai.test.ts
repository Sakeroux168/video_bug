// tests/organizer-ai.test.ts — 按作者品类判定（Task 13）
//
// 三层 mock，全部不碰真实 IO：
//   · deps.analyzer 注入假对象（classifyWithMedia 返回想要的品类 / 抛错）
//   · deps.asr.transcribeFor 注入假实现（一条样本有语音、一条无语音）
//   · vi.mock 顶掉 extractFrames —— 不真调 ffmpeg，返回测试预写的假帧文件
// 断言 focus 在：返回品类正确 + prompt 里带"无语音"标注 + 依赖缺失/异常时返回 null。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyAuthor } from '../src/main/ai/organizer-ai'
import type { AuthorRow, VideoRow } from '../src/shared/types'
import type { Analyzer } from '../src/main/analyzer'

// extractFrames 换成假实现 —— 编排测试不该真调 ffmpeg
vi.mock('../src/main/asr/media', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, extractFrames: vi.fn() }
})

import { extractFrames } from '../src/main/asr/media'

const author: AuthorRow = {
  id: 1, platform: 'douyin', sec_uid: 'sec-1', nickname: '美食老王',
  home_url: null, video_count: 10, last_fetched_at: null, note: null,
  category: null, organize_state: null, ai_classified_at: null
}

function sample(awemeId: string, title: string): VideoRow {
  return {
    id: 0, platform: 'douyin', task_id: 1, aweme_id: awemeId, title,
    author_id: 1, play_addr: null, duration: 30, publish_time: null,
    stats: '{}', ai_verdict: null, ai_tags: null, status: 'done',
    local_path: `C:\\fake\\${awemeId}.mp4`, file_size: 1, error: null,
    retry_count: 0, fetched_at: '2026-01-01T00:00:00Z', downloaded_at: '2026-01-01T00:00:00Z'
  }
}

// 测试用的帧文件（extractFrames mock 返回它们，readFile 能真读到）
let dir: string
let frames: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'org-ai-test-'))
  const f1 = join(dir, 'frame_01.jpg')
  const f2 = join(dir, 'frame_02.jpg')
  writeFileSync(f1, Buffer.from([0xff, 0xd8, 0xff]))
  writeFileSync(f2, Buffer.from([0xff, 0xd8, 0xff]))
  frames = [f1, f2]
  vi.mocked(extractFrames).mockResolvedValue(frames)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('classifyAuthor', () => {
  it('mock analyzer/asr/抽帧 → 返回品类且 prompt 含无语音标注', async () => {
    const classifyWithMedia = vi.fn(async () => ({ category: '美食', tags: [] }))
    const analyzer = { classifyWithMedia } as unknown as Analyzer
    const asr = {
      transcribeFor: vi.fn(async (row: VideoRow) => ({
        text: row.aweme_id === 'A1'
          ? '这家店的招牌菜非常好吃，值得推荐，下次再来。'
          : '嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯',
        speechSec: 20, totalSec: 30,
        likelySpeech: row.aweme_id === 'A1',
        fromCache: false
      }))
    }
    const deps = { analyzer, asr, ffmpeg: 'ffmpeg-mock' }

    const category = await classifyAuthor(author, [sample('A1', '周末探店'), sample('A2', '背景音乐视频')], deps)

    expect(category).toBe('美食')
    // prompt 第一参：作者昵称 + 样本标题 + 无语音标注
    const prompt = classifyWithMedia.mock.calls[0][0] as string
    expect(prompt).toContain('作者昵称：美食老王')
    expect(prompt).toContain('周末探店')
    expect(prompt).toContain('[无语音·纯背景声]')
    // 第二参是帧 base64 data URL 列表（2 条样本 × 每样本 2 帧）
    const images = classifyWithMedia.mock.calls[0][1] as Array<{ dataUrl: string }>
    expect(images).toHaveLength(4)
    expect(images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('analyzer 抛错 → 返回 null', async () => {
    const analyzer = {
      classifyWithMedia: vi.fn(async () => { throw new Error('ai_http_500') })
    } as unknown as Analyzer
    const asr = {
      transcribeFor: vi.fn(async () => ({
        text: '这是一段正常的说话内容。', speechSec: 10, totalSec: 12,
        likelySpeech: true, fromCache: false
      }))
    }

    const category = await classifyAuthor(author, [sample('A1', '探店')], { analyzer, asr, ffmpeg: 'ffmpeg-mock' })
    expect(category).toBeNull()
  })

  it('analyzer/asr/ffmpeg 任一缺失 → 直接 null（上层回退文字分类）', async () => {
    const category = await classifyAuthor(author, [sample('A1', '探店')], {
      analyzer: null, asr: null, ffmpeg: null
    })
    expect(category).toBeNull()
  })
})
