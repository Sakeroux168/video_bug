import React, { useState } from 'react'
import { Tabs } from './components/ui'
import FilterForm from './components/FilterForm'
import TaskList from './components/TaskList'
import AuthorCollection from './components/AuthorCollection'
import BrowserPanel from './components/BrowserPanel'
import SettingsPanel from './components/SettingsPanel'
import { api } from './api'
import type { CreateTaskInput } from '../../shared/types'

export default function App(): JSX.Element {
  const [tab, setTab] = useState('panel')

  async function startTask(input: CreateTaskInput): Promise<{ id: number | null; skipped: boolean; reason?: string }> {
    return api.createTask(input)
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-800">
      <header className="border-b border-zinc-200 bg-white px-4 py-2 text-base font-semibold">视频爬取工具</header>
      <Tabs
        active={tab} onChange={k => {
          setTab(k)
          if (k === 'browser') void api.showBrowser()
          else void api.hideBrowser()
        }}
        tabs={[{ key: 'panel', label: '管理面板' }, { key: 'browser', label: '内置浏览器' }, { key: 'settings', label: '设置' }]}
      />
      <main className="flex-1 overflow-auto p-4">
        {tab === 'panel' && (
          <div className="space-y-4">
            <FilterForm onSubmit={startTask} />
            <TaskList />
            <AuthorCollection />
          </div>
        )}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  )
}
