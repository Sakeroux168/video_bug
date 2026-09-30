import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary, btn } from './ui'
import { useMarqueeSelect } from './useMarqueeSelect'
import { useTableSelection } from './useTableSelection'
import { parsePastedAuthors } from './parsePastedAuthors'
import { parseAuthorsCsv, buildAuthorsCsv, decodeCsvBytes } from './authorsCsv'
import { checkDateRange, describeDateRange } from './dateRange'

type ImportResult = { created: number; results: Array<{ line: number; raw: string; ok: boolean; reason?: string }> }

/** 粘贴示例跟随所选平台：永远写着 douyin.com 的话，导快手作者的人会照着填错。
 *  说明行原样保留，只把示例链接换成当前平台的形态。 */
function importPlaceholder(sample: string): string {
  return   '每行一个作者，名称 + 完整主页链接（顺序不限，用空格/Tab/逗号分隔）：\n' +
    `张三　　　粘贴  ${sample}\n` +
    `李四　　　　　　${sample}`
}

export default function AuthorCollection({ notify }: { notify: (text: string) => void }) {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  // 导入平台：解析器与落库平台都跟它走。以前写死抖音，粘快手链接会被抖音解析器拒绝，
  // 且提示说的是「未识别到抖音主页链接」，用户完全看不出问题在哪。
  const [importPlatform, setImportPlatform] = useState('douyin')
  // 员工反馈：抖音和快手混在一张表里分不清谁是哪的 → 按平台分子 tab
  const [tab, setTab] = useState('')
  // 爬主页确认面板：以前点一下就按写死的 200 条 + 自动下载开跑，员工反馈"没人问过我要爬多少"。
  // 200 条自动下载 = 一晚上几十 GB，而他当时只想看看这个作者有什么。
  const [crawlTarget, setCrawlTarget] = useState<AuthorRow | null>(null)
  const [crawlCount, setCrawlCount] = useState('200')
  const [crawlAuto, setCrawlAuto] = useState(true)
  // R20：可选的日期段——只要这段时间发的作品。默认不勾 = 原来的行为（不限时间）
  const [crawlRangeOn, setCrawlRangeOn] = useState(false)
  const [crawlFrom, setCrawlFrom] = useState('')
  const [crawlTo, setCrawlTo] = useState('')
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string; authorInputPlaceholder: string }>>([])
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])
  // 只列已就绪平台：接入中的平台还不能建任务，导进来的作者也无从爬起
  useEffect(() => { void api.listPlatforms().then(list => setPlatforms(list.filter(p => p.taskReady))) }, [])

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

  // tab = 注册平台 ∪ 数据里实际出现过的平台。
  // 后者不能漏：库里可能有已下架/未注册平台的历史作者，只按注册表生成 tab 会把它们藏起来，
  // 用户会以为数据丢了。显示名取注册表，取不到就用原始平台名。
  const platformTabs = (() => {
    const names: string[] = []
    for (const p of platforms) if (!names.includes(p.name)) names.push(p.name)
    for (const a of authors) if (!names.includes(a.platform)) names.push(a.platform)
    return names.map(name => ({
      name,
      label: platforms.find(p => p.name === name)?.displayName ?? name,
      count: authors.filter(a => a.platform === name).length
    }))
  })()
  // tab 尚未选择或所选平台已消失时回落到第一个，避免出现"选中了一个不存在的 tab"导致整页空白
  const activeTab = platformTabs.some(t => t.name === tab) ? tab : (platformTabs[0]?.name ?? '')
  const visible = authors.filter(a => a.platform === activeTab)
  const activeLabel = platformTabs.find(t => t.name === activeTab)?.label ?? activeTab

  /** 切 tab：必须清空选择。否则在抖音选了几行、切到快手再点「删除选中」，
   *  删掉的是当前根本看不见的抖音作者。 */
  function switchTab(name: string): void {
    setTab(name)
    setSelected(new Set())
    setEditingId(null)
    setImportPlatform(name) // 导入平台跟随当前 tab，省一次选择也避免选错
  }

  const allSelected = visible.length > 0 && visible.every(a => selected.has(a.id))
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(visible.map(a => a.id)))
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
    setSelected(rowClick(a.id, visible.map(x => x.id), selected, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
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

  /** 点「爬主页」只是打开确认面板，不立刻建任务。默认值保持原行为（200 条 + 自动下载）。 */
  function openCrawlPanel(a: AuthorRow): void {
    setCrawlTarget(a)
    setCrawlCount('200')
    setCrawlAuto(true)
    setCrawlRangeOn(false)
    setCrawlFrom('')
    setCrawlTo('')
  }

  // 与筛选表单同一套校验：正整数 1-1000
  const crawlCountValid = /^\d+$/.test(crawlCount.trim()) &&
    Number(crawlCount) >= 1 && Number(crawlCount) <= 1000
  // 没勾「只要这段时间发的」时日期怎么填都不管
  const crawlRangeError = crawlRangeOn ? checkDateRange(crawlFrom, crawlTo) : null

  async function startCrawl(): Promise<void> {
    const a = crawlTarget
    if (!a || !crawlCountValid || crawlRangeError) return
    setCrawlTarget(null) // 先收面板，避免连点重复提交
    // Fix5: 点击立即反馈，让用户知道主页爬取已开始（此前静默启动，用户不知道）
    notify(`正在爬取 ${a.nickname} 的主页…`)
    const targetCount = Number(crawlCount)
    const r = await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: crawlRangeOn
        ? { timeRange: 'custom', startDate: crawlFrom || undefined, endDate: crawlTo || undefined, duration: 'all', targetCount }
        : { timeRange: 'all', duration: 'all', targetCount },
      aiFilterEnabled: false, aiOrganizeEnabled: false,
      autoDownload: crawlAuto,
      // 按日期段抓通常就是「这个作者以前爬过，现在补某段时间的」——不能被「已爬过主页」去重拦掉
      ...(crawlRangeOn ? { allowDuplicateAuthor: true } : {})
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
    if (!r.ok) notify(`整理 ${a.nickname} 失败：${r.error}`)
    else if (r.skipped) notify('未开启任何分类层级，视频保持在下载目录里，无需整理')
    else notify(`已整理 ${a.nickname}：${r.moved} 个视频 → ${r.category}`)
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

  /** 导出作者表 → 只导作者与主页链接两列（用户明确要求）。
   *  只导当前平台 tab 的作者：分了 tab 还把两个平台导进同一张表就白分了。 */
  function exportCsv(): void {
    const csv = buildAuthorsCsv(visible)
    // 加 BOM：Excel 不带 BOM 打开 UTF-8 CSV 会把中文显示成乱码
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `作者表-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    notify(`已导出 ${visible.length} 个${activeLabel}作者`)
  }

  async function submitImport(): Promise<void> {
    const items = parsePastedAuthors(importText)
    setImporting(true)
    try {
      const r = await api.importAuthors(items, importPlatform)
      setImportResult(r)
      notify(r.created > 0 ? `已导入 ${r.created} 个作者` : '本次没有新增作者')
      refresh()
    } finally {
      setImporting(false)
    }
  }

  return (
    <Card title="作者收藏">
      {platformTabs.length > 0 && (
        <div role="tablist" className="mb-3 flex items-center gap-1 border-b border-slate-200 text-sm">
          {platformTabs.map(t => (
            <button
              key={t.name}
              role="tab"
              aria-selected={t.name === activeTab}
              className={t.name === activeTab
                ? 'border-b-2 border-brand-600 px-3 py-1.5 font-medium text-brand-600'
                : 'border-b-2 border-transparent px-3 py-1.5 text-slate-500 hover:text-slate-700'}
              onClick={() => switchTab(t.name)}
            >
              {t.label}
              <span className="ml-1.5 text-xs tabular-nums text-slate-400">{t.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-2 flex items-center gap-3 text-xs">
        {visible.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'text-slate-300'}`}
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
        {visible.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-slate-600 hover:bg-slate-100' : 'text-slate-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected()}
          >
            复制所选{selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        )}
        {visible.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-slate-600 hover:bg-slate-100' : 'text-slate-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected('name')}
          >
            只复制作者
          </button>
        )}
        {visible.length > 0 && (
          <button
            className={`rounded-md px-2 py-1 ${selected.size ? 'text-slate-600 hover:bg-slate-100' : 'text-slate-300'}`}
            disabled={selected.size === 0}
            onClick={() => void copySelected('url')}
          >
            只复制链接
          </button>
        )}
        <button
          className={btn('ghost', 'sm')}
          onClick={toggleImportPanel}
        >
          导入作者
        </button>
        <button
          className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:text-slate-300"
          disabled={visible.length === 0}
          onClick={exportCsv}
        >
          导出 CSV
        </button>
        <span className="text-slate-300">提示：点行排他选中，Ctrl 点选切换，Shift 点选范围，点空白取消，按住左键拖动框选替换</span>
      </div>
      {crawlTarget && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-brand-200 bg-brand-50/40 p-3 text-xs text-slate-600">
          <span className="font-medium text-slate-700">爬取「{crawlTarget.nickname}」的主页</span>
          <label htmlFor="crawl-count" className="flex items-center gap-1">
            目标数量
            <input
              id="crawl-count"
              className="w-20 rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              value={crawlCount}
              onChange={e => setCrawlCount(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="crawl-mode" checked={crawlAuto} onChange={() => setCrawlAuto(true)} />
            <span>自动下载</span>
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="crawl-mode" checked={!crawlAuto} onChange={() => setCrawlAuto(false)} />
            <span>手动挑选</span>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={crawlRangeOn} onChange={e => setCrawlRangeOn(e.target.checked)} />
            <span>只要这段时间发的</span>
          </label>
          {crawlRangeOn && (
            <>
              <label htmlFor="crawl-from" className="flex items-center gap-1">
                从
                <input
                  id="crawl-from"
                  type="date"
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  value={crawlFrom}
                  max={crawlTo || undefined}
                  onChange={e => setCrawlFrom(e.target.value)}
                />
              </label>
              <label htmlFor="crawl-to" className="flex items-center gap-1">
                到
                <input
                  id="crawl-to"
                  type="date"
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  value={crawlTo}
                  min={crawlFrom || undefined}
                  onChange={e => setCrawlTo(e.target.value)}
                />
              </label>
            </>
          )}
          <button className={btn('primary', 'sm')} disabled={!crawlCountValid || !!crawlRangeError} onClick={() => void startCrawl()}>开始爬取</button>
          <button className={btn('ghost', 'sm')} onClick={() => setCrawlTarget(null)}>取消</button>
          {!crawlCountValid && <span className="text-danger-600">数量需在 1-1000</span>}
          {crawlRangeError && <span className="text-danger-600">{crawlRangeError}</span>}
          {crawlRangeOn && !crawlRangeError && (
            <span className="text-slate-400">{describeDateRange(crawlFrom, crawlTo)}（按北京时间，含当天）</span>
          )}
        </div>
      )}
      {importOpen && (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <label htmlFor="import-platform" className="mb-2 flex items-center gap-2 text-xs text-slate-500">
            导入平台
            <select
              id="import-platform"
              className="rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              value={importPlatform}
              onChange={e => setImportPlatform(e.target.value)}
            >
              {platforms.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
            </select>
          </label>
          <textarea
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            rows={5}
            placeholder={importPlaceholder(platforms.find(p => p.name === importPlatform)?.authorInputPlaceholder ?? '')}
            value={importText}
            onChange={e => setImportText(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            {/* 手里有现成作者表的情况：选文件后只抽「作者 + 主页链接」两列填进上方文本框，
                让用户先看一眼再确认——而不是选完文件就直接写库。
                后续走与手工粘贴完全同一条校验链路。 */}
            <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
              选择 CSV 文件
              <input type="file" accept=".csv,.xlsx,.xls,text/csv" className="hidden" onChange={e => void onPickCsv(e)} />
            </label>
            <button
              className={btn('primary', 'sm')}
              disabled={importing || importText.trim() === ''}
              onClick={() => void submitImport()}
            >
              确定导入
            </button>
            <button
              className={btn('ghost', 'sm')}
              onClick={cancelImport}
            >
              取消
            </button>
          </div>
          {importResult && (
            <div className="mt-2 text-xs text-slate-600">
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
      {visible.length === 0 ? (
        <span className="text-sm text-slate-400">
          {authors.length === 0
            ? '暂无收藏的作者，抓取后自动收录，或点上方「导入作者」批量添加'
            : `还没有${activeLabel}作者，抓取后自动收录，或点上方「导入作者」批量添加`}
        </span>
      ) : (
        <div
          ref={containerRef} data-testid="authors-table" className="relative select-none overflow-auto"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onClick={handleContainerClick}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-400">
                <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th className="py-2 pr-2 font-medium">作者</th>
                <th className="py-2 pr-2 font-medium">主页链接</th>
                <th className="py-2 pr-2 font-medium">品类</th>
                <th className="py-2 pr-2 font-medium">视频数</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(a => (
                <tr
                  key={`${a.platform}:${a.sec_uid}`}
                  data-id={a.id}
                  data-selected={selected.has(a.id) ? 'true' : undefined}
                  className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 ${selected.has(a.id) ? 'bg-brand-50' : ''}`}
                  onClick={e => handleRowClick(a, e)}
                >
                  <td className="py-2 pr-1"><input type="checkbox" checked={selected.has(a.id)} onChange={() => setSelected(rowClick(a.id, visible.map(x => x.id), selected, {}))} /></td>
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
                    <a className="block truncate text-slate-600 hover:underline" href={a.home_url ?? '#'} target="_blank" rel="noreferrer">
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
                        autoFocus className="w-32 rounded border border-brand-400 px-2 py-1 text-xs outline-none"
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={() => void saveCategory(a)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveCategory(a); if (e.key === 'Escape') setEditingId(null) }}
                      />
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                        title="点击编辑品类"
                        onClick={() => { setEditingId(a.id); setEditVal(a.category ?? '') }}
                      >
                        {a.category ?? <span className="text-slate-300">未设置</span>}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-2 tabular-nums text-slate-500">{a.video_count}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      <button className={btn('primary', 'sm')} onClick={() => openCrawlPanel(a)}>爬主页</button>
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
              className="pointer-events-none absolute border border-brand-400 bg-brand-200/40"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}
        </div>
      )}
    </Card>
  )
}
