import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskList from '../../src/renderer/src/components/TaskList'
import { describeError } from '../../src/renderer/src/errors'
import type { TaskRow, VideoRow, TaskStats } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 失败展示组件测试（需求 2026-08-02d ②）：describeError 全码映射、失败行中文原因、
// 「只看失败」先过滤后搜索

function makeTask(id = 1): TaskRow {
  return {
    id, platform: 'douyin', type: 'keyword', query: '测试', filters: '{}',
    status: 'done', target_count: 10, fetched_count: 10, auto_download: 0,
    error: null, created_at: '2026-08-02T00:00:00.000Z', finished_at: null
  }
}

function makeVideo(id: number, overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id, platform: 'douyin', task_id: 1, aweme_id: `aweme-${id}`, title: `视频${id}`,
    author_id: null, play_addr: null, cover_url: null, cover_path: null,
    video_width: 0, video_height: 0, duration: 60, publish_time: '2026-08-01T00:00:00.000Z',
    stats: '{}', ai_verdict: null, ai_tags: null, status: 'done', local_path: null,
    file_size: null, error: null, retry_count: 0, fetched_at: '2026-08-01T00:00:00.000Z',
    downloaded_at: null, author_nickname: '作者', ...overrides
  }
}

function makeStats(videos: VideoRow[]): TaskStats {
  const s: TaskStats = { total: videos.length, done: 0, failed: 0, downloading: 0, pending: 0, filtered: 0, collected: 0, cancelled: 0, paused: 0 }
  for (const v of videos) {
    if (v.status === 'done') s.done++
    else if (v.status === 'failed') s.failed++
    else if (v.status === 'collected') s.collected++
  }
  return s
}

/** 渲染 TaskList（1 个任务）并展开任务，视频异步加载完成 */
async function setup(videos: VideoRow[]): Promise<void> {
  installFakeApi()
  vi.mocked(window.api.onTaskProgress).mockReturnValue(() => {})
  vi.mocked(window.api.listTasks).mockResolvedValue([makeTask()])
  vi.mocked(window.api.getTaskStats).mockResolvedValue(makeStats(videos))
  vi.mocked(window.api.listTaskVideos).mockResolvedValue(videos)

  render(<TaskList notify={() => {}} />)
  fireEvent.click(await screen.findByText('展开'))
}

describe('describeError 全码映射', () => {
  it('已知错误码 → 中文原因', () => {
    expect(describeError('network')).toBe('网络错误（已自动重试2次）')
    expect(describeError('address_expired')).toBe('下载链接已过期')
    expect(describeError('forbidden')).toBe('平台拒绝（可能风控）')
    expect(describeError('login_expired')).toBe('登录已过期')
    expect(describeError('disk')).toBe('磁盘错误（目录不可写或空间不足）')
    expect(describeError('parse_error')).toBe('文件解析失败')
    expect(describeError('ai_auth')).toBe('AI认证失败')
    expect(describeError('ai_quota')).toBe('AI额度用尽')
    expect(describeError('ai_timeout')).toBe('AI超时')
    expect(describeError('bad_mp4')).toBe('文件校验失败（非视频）')
  })

  it('未知码返回原文，空码返回「未知错误」', () => {
    expect(describeError('weird_code')).toBe('weird_code')
    expect(describeError('')).toBe('未知错误')
    expect(describeError(null)).toBe('未知错误')
    expect(describeError(undefined)).toBe('未知错误')
  })
})

describe('失败行渲染中文原因', () => {
  beforeEach(() => {
    installFakeApi()
  })

  it('失败行显示 describeError 的中文原因', async () => {
    await setup([
      makeVideo(1),
      makeVideo(2, { status: 'failed', error: 'network' }),
      makeVideo(3, { status: 'failed', error: 'bad_mp4' })
    ])

    expect(await screen.findByText(/网络错误（已自动重试2次）/)).toBeInTheDocument()
    expect(screen.getByText(/文件校验失败（非视频）/)).toBeInTheDocument()
    // 成功行不显示错误原因
    expect(screen.queryByText(/未知错误/)).not.toBeInTheDocument()
  })
})

describe('只看失败', () => {
  beforeEach(() => {
    installFakeApi()
  })

  it('先过滤后搜索：只看失败 + 关键词，只显示失败的匹配行', async () => {
    await setup([
      makeVideo(1, { title: '普通视频A' }),
      makeVideo(2, { title: '失败视频A', status: 'failed', error: 'network' }),
      makeVideo(3, { title: '失败视频B', status: 'failed', error: 'bad_mp4' })
    ])

    // 展开后三条都在
    expect(await screen.findByText('普通视频A')).toBeInTheDocument()
    expect(screen.getByText('失败视频A')).toBeInTheDocument()
    expect(screen.getByText('失败视频B')).toBeInTheDocument()

    // 点「只看失败」→ 成功行消失
    fireEvent.click(screen.getByText('只看失败'))
    expect(screen.queryByText('普通视频A')).not.toBeInTheDocument()
    expect(screen.getByText('失败视频A')).toBeInTheDocument()
    expect(screen.getByText('失败视频B')).toBeInTheDocument()

    // 搜索 'A'：只留失败且匹配的行（普通视频A 匹配关键词但已被只看失败过滤掉 → 不出现）
    fireEvent.change(screen.getByPlaceholderText('搜索标题/作者'), { target: { value: 'A' } })
    expect(screen.getByText('失败视频A')).toBeInTheDocument()
    expect(screen.queryByText('失败视频B')).not.toBeInTheDocument()
    expect(screen.queryByText('普通视频A')).not.toBeInTheDocument()
  })
})
