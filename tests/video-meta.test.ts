import { describe, expect, it, vi } from 'vitest'
import { probeVideoDimensions, screenBucket, type ProbeDeps } from '../src/main/videoMeta'

describe('screenBucket', () => {
  it.each([
    [1080, 1920, '竖屏'],
    [1080, 1080, '竖屏'],
    [1920, 1080, '横屏'],
    [0, 0, '未识别'],
    [-1, 1920, '未识别']
  ])('%sx%s → %s', (width, height, expected) => {
    expect(screenBucket(width, height)).toBe(expected)
  })
})

describe('probeVideoDimensions', () => {
  const deps = (output: string, error: Error | null = null): ProbeDeps => ({
    findFfprobe: () => 'C:/ffprobe.exe',
    execFile: vi.fn((_file, _args, callback) => callback(error, output))
  })

  it('读取第一条视频流的有效宽高', async () => {
    const d = deps(JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }))
    await expect(probeVideoDimensions('D:/a.mp4', d)).resolves.toEqual({ width: 1920, height: 1080 })
    expect(d.execFile).toHaveBeenCalledWith('C:/ffprobe.exe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', 'D:/a.mp4'
    ], expect.any(Function))
  })

  it.each([
    ['损坏 JSON', '{broken', null],
    ['无视频流', JSON.stringify({ streams: [] }), null],
    ['无效宽高', JSON.stringify({ streams: [{ width: 0, height: 1080 }] }), null]
  ])('%s 返回 null', async (_label, output, expected) => {
    await expect(probeVideoDimensions('D:/a.mp4', deps(output))).resolves.toBe(expected)
  })

  it('ffprobe 执行失败返回 null', async () => {
    await expect(probeVideoDimensions('D:/a.mp4', deps('', new Error('failed')))).resolves.toBeNull()
  })

  it('本机找不到 ffprobe 时不执行命令并返回 null', async () => {
    const d: ProbeDeps = { findFfprobe: () => null, execFile: vi.fn() }
    await expect(probeVideoDimensions('D:/a.mp4', d)).resolves.toBeNull()
    expect(d.execFile).not.toHaveBeenCalled()
  })
})
