import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationStatus } from '../shared/types'

/**
 * 定时追更的运行记录（上次什么时候跑、建了几个任务）。单独一个文件，不放 settings.json：
 * 设置页保存时会把整份设置写回去，记录放在那里会被界面里的旧值盖掉。
 */
type State = Pick<AutomationStatus, 'lastFollowAt' | 'lastResult'>

function file(): string {
  return join(app.getPath('userData'), 'automation.json')
}

export function loadAutomationState(): State {
  try {
    const o = JSON.parse(readFileSync(file(), 'utf8')) as Partial<State>
    return { lastFollowAt: typeof o.lastFollowAt === 'string' ? o.lastFollowAt : null, lastResult: o.lastResult ?? null }
  } catch {
    return { lastFollowAt: null, lastResult: null }
  }
}

export function saveAutomationState(patch: Partial<State>): void {
  try {
    writeFileSync(file(), JSON.stringify({ ...loadAutomationState(), ...patch }), 'utf8')
  } catch (e) {
    console.error('[定时追更] 记录写不进去：', e)
  }
}
