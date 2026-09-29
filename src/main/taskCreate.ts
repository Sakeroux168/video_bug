import type { DatabaseSync } from 'node:sqlite'
import { createTask } from './db'
import { getSettings } from './settings'
import { getAdapter } from './adapters'
import type { CreateTaskInput } from '../shared/types'

export interface CreateTaskResult {
  id: number | null
  skipped: boolean
  reason?: string
}

/**
 * 建任务前的两道检查（原本写在 ipc 的 task:create 里，R18 抽出来给本机 HTTP 口共用）：
 * 1. type=author 时把 query 归一化成 sec_uid（完整主页 URL / 裸 sec_uid 都认；短链不认）——
 *    修复 FilterForm 存完整 URL、scheduler 又套一层 buildAuthorUrl 拼出双重 URL 的静默卡死 bug，
 *    顺带修复去重键分裂（两条入口各存一种格式互不相认）。
 * 2. 作者去重：仅当该作者的「主页爬取」任务已 done 才跳过；任务级 allowDuplicateAuthor 覆盖全局设置。
 *    比对时对已有 done 行的 query 也归一化一次（库里可能有修复前存的完整 URL 历史行）。
 * 通过检查就入库并 enqueue；返回值形状与 task:create 一致。
 */
export function createTaskChecked(db: DatabaseSync, rawInput: CreateTaskInput, enqueue: (id: number) => void): CreateTaskResult {
  let input = rawInput
  // 接入中的平台（解析器还没按真机接口写）不能建任务。
  // 它仍然注册在平台表里，是为了让内置浏览器能打开它去扫码登录、抓真实接口；
  // 但放进建任务这一侧就成了「平台能选、任务跑不通」的半成品。
  const platformAdapter = getAdapter(input.platform)
  if (platformAdapter && !platformAdapter.taskReady) {
    return { id: null, skipped: true, reason: `${platformAdapter.displayName}还在接入中，暂不支持建任务；可在「内置浏览器」页打开并登录` }
  }
  if (platformAdapter?.supportedTaskTypes && !platformAdapter.supportedTaskTypes.includes(input.type)) {
    return { id: null, skipped: true, reason: `${platformAdapter.displayName}暂不支持此任务类型，请使用关键词或话题抓取` }
  }
  if (input.type === 'author') {
    const adapter = getAdapter(input.platform)
    const secUid = adapter?.parseAuthorInput(input.query) ?? null
    if (secUid === null) {
      // 文案跟随平台：选了快手却提示"未识别到抖音主页链接"会把人带沟里
      const site = adapter?.displayName ?? input.platform
      const reason = adapter?.isShortLink(input.query)
        ? '暂不支持短链接，请粘贴完整主页链接' // 与批量导入同一句，别让同一件事有两种说法
        : `未识别到${site}主页链接或作者 ID`
      return { id: null, skipped: true, reason }
    }
    input = { ...input, query: secUid }
  }
  if (input.type === 'author' && !(input.allowDuplicateAuthor ?? getSettings().allowDuplicateAuthor)) {
    const adapter = getAdapter(input.platform)
    const doneRows = db.prepare("SELECT query FROM tasks WHERE type='author' AND status='done'")
      .all() as Array<{ query: string }>
    const dup = doneRows.some(r => (adapter?.parseAuthorInput(r.query) ?? r.query) === input.query)
    if (dup) return { id: null, skipped: true, reason: '该作者主页已爬取过，可在作者表格中直接管理' }
  }
  const id = createTask(db, input)
  enqueue(id)
  return { id, skipped: false }
}
