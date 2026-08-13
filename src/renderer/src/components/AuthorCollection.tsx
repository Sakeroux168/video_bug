import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'
import { useMarqueeSelect } from './useMarqueeSelect'
import { useTableSelection } from './useTableSelection'
import { parsePastedAuthors } from './parsePastedAuthors'
import { parseAuthorsCsv, buildAuthorsCsv, decodeCsvBytes } from './authorsCsv'

type ImportResult = { created: number; results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> }

const IMPORT_PLACEHOLDER =
  '每行一个作者，名称 + 完整主页链接（顺序不限，用空格/Tab/逗号分隔）：\n' +
  '张三的日常  https://www.douyin.com/user/MS4wLjABAAAA_abc123\n' +
  '李四        https://www.douyin.com/user/MS4wLjABAAAA_def456'

export default function AuthorCollection({ notify }: { notify: (text: string) => void }) {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  // 作者校验的结果是调度器写进库的，不订阅就永远停在旧数据上——
  // 用户只能看到一闪而过的 toast。任务暂停/完成都可能改变作者行
  // （校验状态、视频数），收到就重拉。进度事件很密，不能无差别刷。
  useEffect(() => {
    return api.onTaskProgress(e => {
      const t = e as unknown as { type?: string; status?: string }
      if (t?.type === 'task:paused' || t?.status === 'done' || t?.status === 'paused') {
        void api.listAuthors().then(setAuthors)
      }
    })
  }, [])

  function refresh(): void { void api.listAuthors().then(setAuthors) }

  const allSelected = authors.length > 0 && authors.every(a => selected.has(a.id))
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(authors.map(a => a.id)))
  }

  // 行选择终版语义（排他/ctrl 切换/shift 范围），锚点按本组件实例独立
  const { rowClick } = useTableSelection<number>()

  // —— 拖拽框选（纯替换：松手后选中集合 = 框内命中的行，框外一律取消；不改锚点）——
  const { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag } = useMarqueeSelect({
    onSelect: ids => setSelected(new Set(ids))
  })

  // 点行任意位置选择（勾选框/链接/按钮不触发行切换；拖拽框选后的 click 不切换）
  function handleRowClick(a: AuthorRow, e: React.MouseEvent): void {
    if (didDragRef.current) return
    if ((e.target as HTMLElement).closest('button, a, input')) return
    setSelected(rowClick(a.id, authors.map(x => x.id), selected, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
  }

  // 点容器内空白区域（非行、非交互元素）→ 清空全部选择；
  // 跨行拖拽松手后 click 在公共祖先（tbody）派发并冒泡到这里，需用 didDragRef 跳过
  function handleContainerClick(e: React.MouseEvent): void {
    if (didDragRef.current) return
    const t = e.target as HTMLElement
    if (t.closest('tr, button, a, input')) return
    setSelected(new Set())
  }

  async function deleteSelected(): Promise<void> {
    if (selected.size === 0) return
    await api.deleteAuthors([...selected])
    setSelected(new Set())
    notify(`已删除 ${selected.size} 个作者`)
    refresh()
  }
  async function deleteOne(id: number): Promise<void> {
    await api.deleteAuthors([id])
    notify('已删除该作者')
    refresh()
  }

  async function crawlHome(a: AuthorRow): Promise<void> {
    // Fix5: 点击立即反馈，让用户知道主页爬取已开始（此前静默启动，用户不知道）
    notify(`正在爬取 ${a.nickname} 的主页…`)
    const r = await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
      aiFilterEnabled: false, aiOrganizeEnabled: false,
      autoDownload: true // 爬作者主页当前默认自动下载
    })
    if (r.skipped) notify(r.reason ?? '该作者主页已爬取过')
    else notify(`已开始爬取 ${a.nickname} 的主页，可在任务列表查看进度`)
  }

  async function saveCategory(a: AuthorRow): Promise<void> {
    const v = editVal.trim()
    if (v !== (a.category ?? '')) {
      await api.updateAuthorCategory(a.id, v)
      setAuthors(prev => prev.map(x => (x.id === a.id ? { ...x, category: v || null } : x)))
    }
    setEditingId(null)
  }

  async function organizeOne(a: AuthorRow): Promise<void> {
    const r = await api.organizeAuthor(a.id)
    if (r.ok) notify(`已整理 ${a.nickname}：${r.moved} 个视频 → ${r.category}`)
    else notify(`整理 ${a.nickname} 失败：${r.error}`)
    refresh()
  }

  function toggleImportPanel(): void {
    setImportOpen(v => !v)
  }
  function cancelImport(): void {
    setImportOpen(false)
    setImportText('')
    setImportResult(null)
  }
  /**
   * 复制选中的作者 → 剪贴板。制表符分隔，粘进 Excel/表格会自动分成两列。
   *
   * 为什么不是「让单元格可选中」：框选要求容器 select-none，开了文本选中就会把
   * 作者名/链接那两列变成框选的死区（它俩占了行宽大部分）——相当于用框选换复制。
   * 先框选、再一键复制，两个能力都保住。
   */
  async function copySelected(what: 'both' | 'name' | 'url' = 'both'): Promise<void> {
    const rows = authors.filter(a => selected.has(a.id))
    if (rows.length === 0) return
    const line = (a: AuthorRow): string =>
      what === 'name' ? a.nickname
        : what === 'url' ? (a.home_url ?? '')
          : `${a.nickname}\t${a.home_url ?? ''}`
    await api.writeClipboard(rows.map(line).join('\n'))
    const label = what === 'name' ? '作者名' : what === 'url' ? '主页链接' : '作者与链接（制表符分隔，可直接粘进表格）'
    notify(`已复制 ${rows.length} 条${label}`)
  }

  /**
   * 选文件 → 只抽作者与主页链接两列，回填到文本框供确认。
   *
   * 读字节而不是直接 file.text()：用户很容易选成 .xlsx（本质是 zip），
   * 当文本硬读会把压缩包字节填满文本框、再产出几十条「未识别」的假失败行；
   * 中文 Excel 另存为 CSV 默认又是 GBK，按 UTF-8 读同样乱码。两件事都在 decodeCsvBytes 里处理。
   */
  async function onPickCsv(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0]
    e.target.value = '' // 先清空：同一个文件修好后再选一次也能触发 change
    if (!f) return
    const decoded = decodeCsvBytes(await f.arrayBuffer())
    if (!decoded.ok) {
      setImportResult({ created: 0, results: [{ line: 0, raw: f.name, ok: false, reason: decoded.error }] })
      return
    }
    const rows = parseAuthorsCsv(decoded.text)
    setImportText(rows.map(r => `${r.nickname} ${r.url}`).join('\n'))
  }

  /** 导出作者表 → 只导作者与主页链接两列（用户明确要求） */
  function exportCsv(): void {
    const csv = buildAuthorsCsv(authors)
    // 加 BOM：Excel 不带 BOM 打开 UTF-8 CSV 会把中文显示成乱码
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `作者表-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    notify(`已导出 ${authors.length} 个作者`)
  }

  async function submitImport(): Promise<void> {
    const items = parsePastedAuthors(importText)
    setImporting(true)
    try {
      const r = await api.importAuthors(items)
      setImportResult(r)
      notify(r.created > 0 ? `已导入 ${r.created} 个作者` : '本次没有新增作者')
      refresh()
    } finally {
      setImporting(false)
    }
  }

  return (
    <Card title="作者收藏">
      <div className="mb-2 flex items-center gap-3 text-xs">
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-zinc-600 hover:bg-zinc-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected()}
          >
            复制所选{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-zinc-600 hover:bg-zinc-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected('name')}
          >
            只复制作者
          </button>
        )}
        {authors.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-zinc-600 hover:bg-zinc-100' : 'text-zinc-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected('url')}
          >
            只复制链接
          </button>
        )}
        <button
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100"
          onClick={toggleImportPanel}
        >
          导入作者
        </button>
        <button
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 disabled:text-zinc-300"
          disabled={authors.length === 0}
          onClick={exportCsv}
        >
          导出 CSV
        </button>
        <span className="text-zinc-300">提示：点行排他选中，Ctrl 点选切换，Shift 点选范围，点空白取消，按住左键拖动框选替换</span>
      </div>
      {importOpen && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <textarea
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            rows={5}
            placeholder={IMPORT_PLACEHOLDER}
            value={importText}
            onChange={e => setImportText(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            {/* 手里有现成作者表的情况：选文件后只抽「作者 + 主页链接」两列填进上方文本框，
                让用户先看一眼再确认——而不是选完文件就直接写库。
                后续走与手工粘贴完全同一条校验链路。 */}
            <label className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100">
              选择 CSV 文件
              <input type="file" accept=".csv,.xlsx,.xls,text/csv" className="hidden" onChange={e => void onPickCsv(e)} />
            </label>
            <button
              className={`${btnPrimary} !px-3 !py-1.5 !text-xs`}
              disabled={importing || importText.trim() === ''}
              onClick={() => void submitImport()}
            >
              确定导入
            </button>
            <button
              className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100"
              onClick={cancelImport}
            >
              取消
            </button>
          </div>
          {importResult && (
            <div className="mt-2 text-xs text-zinc-600">
              <div>成功导入 {importResult.created} 个</div>
              {importResult.results.some(r => !r.ok) && (
                <ul className="mt-1 space-y-0.5 text-red-500">
                  {importResult.results.filter(r => !r.ok).map(r => (
                    <li key={r.line}>
                      第 {r.line} 行「{r.raw}」：{r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {authors.length === 0 ? (
        <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加</span>
      ) : (
        <div
          ref={containerRef} data-testid="authors-table" className="relative select-none overflow-auto"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onClick={handleContainerClick}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-400">
                <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th className="py-2 pr-2 font-medium">作者</th>
                <th className="py-2 pr-2 font-medium">主页链接</th>
                <th className="py-2 pr-2 font-medium">品类</th>
                <th className="py-2 pr-2 font-medium">视频数</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {authors.map(a => (
                <tr
                  key={`${a.platform}:${a.sec_uid}`}
                  data-id={a.id}
                  data-selected={selected.has(a.id) ? 'true' : undefined}
                  className={`cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 ${selected.has(a.id) ? 'bg-blue-50' : ''}`}
                  onClick={e => handleRowClick(a, e)}
                >
                  <td className="py-2 pr-1"><input type="checkbox" checked={selected.has(a.id)} onChange={() => setSelected(rowClick(a.id, authors.map(x => x.id), selected, {}))} /></td>
                  <td className="py-2 pr-2 font-medium">
                    {a.nickname}
                    {/* R16：导入的作者需要校验名称与链接是否对得上。
                        verify_state 为 null = 抓取时自动收录，数据来自真实接口，不显示任何标识。 */}
                    {a.verify_state === 'pending' && (
                      <span className="ml-1.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-600" title="导入的作者尚未核实，首次「爬主页」时会自动校验">待校验</span>
                    )}
                    {a.verify_state === 'failed' && (
                      <span className="ml-1.5 rounded bg-red-50 px-1 py-0.5 text-[10px] text-red-600" title={a.verify_error ?? ''}>校验失败</span>
                    )}
                  </td>
                  <td className="max-w-[240px] py-2 pr-2">
                    <a className="block truncate text-blue-500 hover:underline" href={a.home_url ?? '#'} target="_blank" rel="noreferrer">
                      {a.home_url ?? '—'}
                    </a>
                    {/* 拒绝爬取的原因常驻在链接下方。不能只靠 toast：
                        它 3 秒就消失，用户根本来不及看完一句带两个名字的对比说明。 */}
                    {a.verify_error && (
                      <div className="mt-0.5 whitespace-normal text-[10px] leading-snug text-red-500">{a.verify_error}</div>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    {editingId === a.id ? (
                      <input
                        autoFocus className="w-32 rounded border border-blue-400 px-2 py-1 text-xs outline-none"
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={() => void saveCategory(a)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveCategory(a); if (e.key === 'Escape') setEditingId(null) }}
                      />
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                        title="点击编辑品类"
                        onClick={() => { setEditingId(a.id); setEditVal(a.category ?? '') }}
                      >
                        {a.category ?? <span className="text-zinc-300">未设置</span>}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-zinc-500">{a.video_count}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      <button className={`${btnPrimary} !px-2 !py-1 !text-xs`} onClick={() => void crawlHome(a)}>爬主页</button>
                      <button className="rounded px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-50" onClick={() => void organizeOne(a)}>整理</button>
                      <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50" onClick={() => void deleteOne(a.id)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {marquee && (
            <div
              className="pointer-events-none absolute border border-blue-400 bg-blue-200/40"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}
        </div>
      )}
    </Card>
  )
}
