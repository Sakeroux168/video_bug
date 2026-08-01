import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, listTasks, insertVideos, listVideos, upsertAuthor, listAuthors, setVideoStatus, listPendingVideos, setTaskStatus } from '../src/main/db'
import type { CreateTaskInput, Filters } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
})

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false
}

const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId: 'AW1', title: '标题1', authorSecUid: 'SEC1', authorNickname: '作者1',
  authorHomeUrl: 'https://www.douyin.com/user/SEC1', playUrl: 'https://v/play/1',
  durationSec: 60, publishTime: 1710000000, likes: 10, ...over
})

describe('db', () => {
  it('创建任务并回读', () => {
    const id = createTask(db, input)
    const rows = listTasks(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('pending')
  })

  it('insertVideos 去重：同 (platform,aweme_id) 只入一次', () => {
    const id = createTask(db, input)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(1)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(0)
    expect(listVideos(db, id)).toHaveLength(1)
  })

  it('upsertAuthor 幂等，video_count 累加', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const authors = listAuthors(db)
    expect(authors).toHaveLength(1)
    expect(authors[0].video_count).toBe(2)
  })

  it('setVideoStatus 更新状态', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'downloading')
    expect(listVideos(db, id)[0].status).toBe('downloading')
  })

  it('listPendingVideos 只返回 pending', () => {
    const id = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AW1' })], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'done')
    expect(listPendingVideos(db).map(x => x.aweme_id).sort()).toEqual(['AW2'])
  })

  it('setTaskStatus 更新任务', () => {
    const id = createTask(db, input)
    setTaskStatus(db, id, 'running')
    setTaskStatus(db, id, 'done')
    expect(listTasks(db)[0].status).toBe('done')
  })
})
