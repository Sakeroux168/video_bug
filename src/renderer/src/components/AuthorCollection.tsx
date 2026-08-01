import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'

export default function AuthorCollection() {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  async function crawlHome(a: AuthorRow): Promise<void> {
    await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
      aiFilterEnabled: false, aiOrganizeEnabled: false
    })
  }

  return (
    <Card title="作者收藏">
      <div className="flex flex-wrap gap-2">
        {authors.map(a => (
          <div key={`${a.platform}:${a.sec_uid}`} className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm">
            <span className="font-medium">{a.nickname}</span>
            <span className="text-xs text-zinc-400">{a.video_count}个视频</span>
            <button className={`${btnPrimary} !px-2 !py-1 !text-xs`} onClick={() => void crawlHome(a)}>爬主页</button>
          </div>
        ))}
        {authors.length === 0 && <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录</span>}
      </div>
    </Card>
  )
}
