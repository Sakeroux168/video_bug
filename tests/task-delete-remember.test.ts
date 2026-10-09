import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus, deleteTaskKeepMemory, reclaimSeenVideo } from '../src/main/db'
import type { VideoItem } from '../src/main/adapters/types'
import type { CreateTaskInput } from '../src/shared/types'

// 2026-10-09 用户：任务用不上了想删，可一删软件就忘了这些视频，以后再抓同样的会重复下载，
// 只好让任务一直堆着。改成：删任务 = 任务从列表消失，但软件还记得它抓过的视频（不重复下）；
// 下好的照样在素材库；没下的不再下。想重复下的，建任务时勾「以前下过的也重新下」。

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); initDb(db) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '猫', filters: { timeRange: 'all', duration: 'all', targetCount: 20 },
  aiFilterEnabled: false, aiOrganizeEnabled: false, autoDownload: true
}
const item = (id: string): VideoItem => ({
  awemeId: id, title: id, authorSecUid: 'S', authorNickname: '作者', authorHomeUrl: 'h',
  playUrl: 'https://v.douyinvod.com/' + id, coverUrl: '', width: 1, height: 1, durationSec: 1, publishTime: 1759000000, likes: 0
})
const row = (aweme: string) => db.prepare('SELECT task_id, status, local_path FROM videos WHERE aweme_id = ?').get(aweme) as { task_id: number; status: string; local_path: string | null }

function seed(): number {
  const t = createTask(db, input)
  insertVideos(db, [item('DONE'), item('WAIT'), item('FAIL'), item('GONE')], t, 'douyin')
  const ids = Object.fromEntries(listVideos(db, t).map(v => [v.aweme_id, v.id]))
  setVideoStatus(db, ids.DONE, 'done', { local_path: 'D:/下载/DONE.mp4' })
  setVideoStatus(db, ids.FAIL, 'failed')
  setVideoStatus(db, ids.GONE, 'deleted')
  return t
}

describe('删任务：任务没了，但软件还记得它的视频', () => {
  it('任务行删掉；下好的原样留着（素材库还看得到）；没下的标成「不要了」', () => {
    const t = seed()
    deleteTaskKeepMemory(db, t)
    expect(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id = ?').get(t)).toEqual({ c: 0 })
    expect(row('DONE')).toMatchObject({ status: 'done', local_path: 'D:/下载/DONE.mp4' })
    expect(row('WAIT').status).toBe('deleted')
    expect(row('FAIL').status).toBe('deleted')
    expect(row('GONE').status).toBe('deleted')
  })

  it('以后别的任务再抓到这些视频 → 不重复入库、不重复下载', () => {
    const t = seed()
    deleteTaskKeepMemory(db, t)
    const t2 = createTask(db, input)
    expect(insertVideos(db, [item('DONE'), item('WAIT'), item('NEW')], t2, 'douyin')).toBe(1)
    expect(listVideos(db, t2).map(v => v.aweme_id)).toEqual(['NEW'])
  })
})

describe('「以前下过的也重新下」：把以前抓过的视频领到这个任务里重新下', () => {
  it('删掉任务留下的、下好的、自己删的，都能领过来重新下（清掉旧路径）', () => {
    const t = seed()
    deleteTaskKeepMemory(db, t)
    const t2 = createTask(db, input)
    for (const id of ['DONE', 'WAIT', 'GONE']) {
      expect(reclaimSeenVideo(db, 'douyin', item(id), t2, 'pending')).not.toBeNull()
      expect(row(id)).toMatchObject({ task_id: t2, status: 'pending', local_path: null })
    }
  })

  it('本任务自己刚抓到的、别的任务正在下载的 → 不动', () => {
    const t = createTask(db, input)
    insertVideos(db, [item('MINE'), item('BUSY')], t, 'douyin')
    const busy = listVideos(db, t).find(v => v.aweme_id === 'BUSY')!
    setVideoStatus(db, busy.id, 'downloading')
    expect(reclaimSeenVideo(db, 'douyin', item('MINE'), t, 'pending')).toBeNull()
    const t2 = createTask(db, input)
    expect(reclaimSeenVideo(db, 'douyin', item('BUSY'), t2, 'pending')).toBeNull()
    expect(row('BUSY')).toMatchObject({ task_id: t, status: 'downloading' })
  })
})
