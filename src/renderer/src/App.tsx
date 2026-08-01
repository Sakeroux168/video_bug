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
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2">
        <span className="text-base font-semibold">视频爬取工具</span>
        <button
          type="button"
          className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100"
          onClick={() => void api.openBrowserDevtools()}
        >
          抖音调试控制台
        </button>
      </header>
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
