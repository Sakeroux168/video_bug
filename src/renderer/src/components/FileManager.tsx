import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { FilesTree, FilesTreeAuthor } from '../../../shared/types'
import { Card, btn } from './ui'
import { useMarqueeSelect } from './useMarqueeSelect'
import { useTableSelection } from './useTableSelection'
import { buildVideosCsv, toVideoExportRows, saveCsvFile, csvFileName, filterVideosUnder } from './videosCsv'

/** 字节 → MB 字符串（保留 1 位小数，行内列用） */
function formatMB(size: number): string {
  return (size / 1024 / 1024).toFixed(1)
}

/** 字节 → 可读大小（>=1GB 显示 GB 两位小数，否则 MB 一位小数；顶部汇总用） */
function formatSize(size: number): string {
  const mb = size / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

/** 拼接下载目录与子路径（renderer 不引 node:path；正斜杠 win32 解析兼容，主进程 isPathInside 不受影响） */
function joinPath(base: string, ...parts: string[]): string {
  return `${base.replace(/[\\/]+$/, '')}/${parts.join('/')}`
}

/**
 * Task4 文件管理 tab：读下载目录的品类文件夹（以磁盘为准）。
 * 一级页品类表格（勾选/框选/删除选中/点行进二级）→ 二级页作者表格（返回/批量）；
 * 删除 = 永久删除文件夹（递归）+ DB 联动，window.confirm 二次确认，删除后刷新。
 */
export default function FileManager({ notify }: { notify: (text: string) => void }) {
  const [tree, setTree] = useState<FilesTree | null>(null)
  const [current, setCurrent] = useState<string | null>(null) // 进入的品类名（null = 一级页）
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set())
  const [selectedAuthors, setSelectedAuthors] = useState<Set<string>>(new Set())

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    setTree(await api.getFilesTree())
  }

  const cats = tree?.categories ?? []
  const cat = current ? cats.find(c => c.name === current) : undefined
  const authors: FilesTreeAuthor[] = cat?.authors ?? []
  const downloadDir = tree?.downloadDir ?? ''

  // 平台显示名来自 platforms:list（源头是各适配器的 displayName），未知平台回落原始名
  const [platformNames, setPlatformNames] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.listPlatforms().then(list => setPlatformNames(Object.fromEntries(list.map(p => [p.name, p.displayName]))))
  }, [])

  /**
   * 导出视频数据表。segments 为空 = 全部已下载；给了就只导那个文件夹底下的。
   * 按路径前缀筛而不是按品类字段筛：归档层级可配，目录结构会变，
   * 按路径判永远和用户在这一页看到的一致。
   */
  async function exportUnder(segments: string[], label: string): Promise<void> {
    const all = await api.listDownloadedVideos()
    const rows = segments.length === 0 ? all : filterVideosUnder(all, downloadDir, segments)
    if (rows.length === 0) {
      notify(`${label}没有已下载的视频，没有可导出的数据`)
      return
    }
    const csv = buildVideosCsv(toVideoExportRows(rows, name => platformNames[name] ?? name))
    saveCsvFile(csv, csvFileName(`视频数据-${label}`))
    notify(`已导出 ${rows.length} 条视频数据（${label}）`)
  }

  /** 跨任务导出所有已下载视频的数据表 */
  async function exportAllDownloaded(): Promise<void> {
    await exportUnder([], '全部已下载')
  }

  /** 导出勾选的多个品类：各自按目录取，合并成一张表 */
  async function exportSelectedCats(): Promise<void> {
    const names = [...selectedCats]
    const all = await api.listDownloadedVideos()
    const rows = names.flatMap(n => filterVideosUnder(all, downloadDir, [n]))
    if (rows.length === 0) {
      notify('选中的品类下没有已下载的视频，没有可导出的数据')
      return
    }
    const csv = buildVideosCsv(toVideoExportRows(rows, name => platformNames[name] ?? name))
    saveCsvFile(csv, csvFileName(`视频数据-${names.length} 个品类`))
    notify(`已导出 ${rows.length} 条视频数据（${names.length} 个品类）`)
  }

  /** 导出勾选的多个作者（当前品类下）：各自按目录取，合并成一张表 */
  async function exportSelectedAuthors(): Promise<void> {
    const names = [...selectedAuthors]
    const all = await api.listDownloadedVideos()
    const rows = names.flatMap(n => filterVideosUnder(all, downloadDir, [current ?? '', n]))
    if (rows.length === 0) {
      notify('选中的作者下没有已下载的视频，没有可导出的数据')
      return
    }
    const csv = buildVideosCsv(toVideoExportRows(rows, name => platformNames[name] ?? name))
    saveCsvFile(csv, csvFileName(`视频数据-${names.length} 个作者`))
    notify(`已导出 ${rows.length} 条视频数据（${names.length} 个作者）`)
  } // 定位路径基准（与 tree 同一次刷新快照，主进程按最新设置二次校验）

  // 两级各自独立锚点；普通点击：一级钻取 / 二级排他选择，Ctrl 切换，Shift 范围（与作者表格语义一致）
  const { rowClick: rowClickCat } = useTableSelection<string>()
  const { rowClick: rowClickAuthor } = useTableSelection<string>()

  // 拖拽框选（纯替换：松手后选中集合 = 框内命中行，框外一律取消）；两级共用同一容器，一次实例即可
  const { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag } = useMarqueeSelect<string>({
    stringIds: true, // 行 data-id 是品类/作者名（字符串）
    onSelect: ids => {
      if (current) setSelectedAuthors(new Set(ids))
      else setSelectedCats(new Set(ids))
    }
  })

  // 一级：点品类行进二级页；Ctrl/Shift 不钻取，走切换/范围选择
  function handleCatClick(name: string, e: React.MouseEvent): void {
    if (didDragRef.current) return
    if ((e.target as HTMLElement).closest('button, a, input')) return
    if (e.ctrlKey || e.shiftKey) {
      setSelectedCats(rowClickCat(name, cats.map(x => x.name), selectedCats, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
      return
    }
    setCurrent(name)
  }

  // 二级：点行排他选中（未选 → 只选该行；已选 → 清空全部）
  function handleAuthorClick(name: string, e: React.MouseEvent): void {
    if (didDragRef.current) return
    if ((e.target as HTMLElement).closest('button, a, input')) return
    setSelectedAuthors(rowClickAuthor(name, authors.map(x => x.name), selectedAuthors, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
  }

  // 点容器内空白区域（非行、非交互元素）→ 清空当前级选择；拖拽后的 click 跳过
  function handleContainerClick(e: React.MouseEvent): void {
    if (didDragRef.current) return
    const t = e.target as HTMLElement
    if (t.closest('tr, button, a, input')) return
    if (current) setSelectedAuthors(new Set())
    else setSelectedCats(new Set())
  }

  // 批量删除：前端循环调单删（主进程逐条防护 + DB 联动），汇总条数与错误
  async function deleteCategories(names: string[]): Promise<void> {
    if (!names.length) return
    const label = names.length === 1 ? `品类「${names[0]}」` : `选中的 ${names.length} 个品类`
    if (!window.confirm(`确定永久删除${label}？将递归删除其中的全部文件，此操作不可恢复`)) return
    let deleted = 0
    let err: string | null = null
    for (const name of names) {
      const r = await api.deleteFileCategory(name)
      deleted += r.deleted
      if (!r.ok && r.error) err = r.error
    }
    setSelectedCats(new Set())
    if (err) notify(deleted > 0 ? `已删除 ${deleted} 条，部分失败：${err}` : `删除失败：${err}`)
    else notify(`已删除 ${deleted} 条`)
    void refresh()
  }

  async function deleteAuthorNames(names: string[]): Promise<void> {
    if (!names.length || !current) return
    const label = names.length === 1 ? `作者「${names[0]}」` : `选中的 ${names.length} 个作者`
    if (!window.confirm(`确定永久删除${label}？将递归删除其中的全部文件，此操作不可恢复`)) return
    let deleted = 0
    let err: string | null = null
    for (const name of names) {
      const r = await api.deleteFileAuthor(current, name)
      deleted += r.deleted
      if (!r.ok && r.error) err = r.error
    }
    setSelectedAuthors(new Set())
    if (err) notify(deleted > 0 ? `已删除 ${deleted} 条，部分失败：${err}` : `删除失败：${err}`)
    else notify(`已删除 ${deleted} 条`)
    void refresh()
  }

  // 定位：主进程校验（路径防护 + 目录存在）后调资源管理器选中；结果 notify 反馈
  async function locateDir(path: string, label: string): Promise<void> {
    const r = await api.locateFileDir(path)
    if (r.ok) notify(`已在资源管理器中定位 ${label}`)
    else notify(`定位失败：${r.error ?? '未知错误'}`)
  }

  const allCats = cats.length > 0 && cats.every(c => selectedCats.has(c.name))
  const allAuthors = authors.length > 0 && authors.every(a => selectedAuthors.has(a.name))

  const hintCls = 'rounded-md px-2 py-1 text-xs'
  const delBtnCls = (n: number) => `${hintCls} ${n ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'text-slate-300'}`

  // —— 二级页：品类下的作者表格 ——
  if (current) {
    return (
      <Card title="文件管理">
        <div className="mb-2 flex items-center gap-3 text-xs">
          <button
            className={btn('secondary', 'sm')}
            onClick={() => { setCurrent(null); setSelectedAuthors(new Set()) }}
          >
            ← 返回品类列表
          </button>
          <span className="text-sm font-medium text-slate-700">当前品类：{current}</span>
          <span className="text-xs tabular-nums text-slate-500">该品类共 {formatSize(cat?.size ?? 0)}</span>
        </div>
        <div className="mb-2 flex items-center gap-3 text-xs">
          <button
            className={delBtnCls(selectedAuthors.size)}
            disabled={selectedAuthors.size === 0}
            onClick={() => void deleteAuthorNames([...selectedAuthors])}
          >
            删除选中作者({selectedAuthors.size})
          </button>
          <button
            className={hintCls + (selectedAuthors.size ? ' text-slate-600 hover:bg-slate-100' : ' text-slate-300')}
            disabled={selectedAuthors.size === 0}
            onClick={() => void exportSelectedAuthors()}
          >
            导出选中作者({selectedAuthors.size})
          </button>
          <button className={btn('secondary', 'sm')} onClick={() => void exportUnder([current], `品类「${current}」`)}>导出本品类</button>
          <button className={btn('secondary', 'sm')} onClick={() => void refresh()}>刷新</button>
          <span className="text-slate-300">提示：点行排他选中，Ctrl 点选切换，Shift 点选范围，点空白取消，按住左键拖动框选替换</span>
        </div>
        {authors.length === 0 ? (
          <span className="text-sm text-slate-400">该品类下没有作者文件夹</span>
        ) : (
          <div
            ref={containerRef} data-testid="files-author-table" className="relative select-none overflow-auto"
            onMouseDown={onMouseDown} onMouseMove={onMouseMove}
            onMouseUp={endDrag} onMouseLeave={endDrag}
            onClick={handleContainerClick}
          >
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-400">
                  <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allAuthors} onChange={() => setSelectedAuthors(allAuthors ? new Set() : new Set(authors.map(a => a.name)))} /></th>
                  <th className="py-2 pr-2 font-medium">作者</th>
                  <th className="py-2 pr-2 font-medium">视频数</th>
                  <th className="py-2 pr-2 font-medium">总大小(MB)</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {authors.map(a => (
                  <tr
                    key={a.name}
                    data-id={a.name}
                    data-selected={selectedAuthors.has(a.name) ? 'true' : undefined}
                    className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 ${selectedAuthors.has(a.name) ? 'bg-brand-50' : ''}`}
                    onClick={e => handleAuthorClick(a.name, e)}
                  >
                    <td className="py-2 pr-1"><input type="checkbox" checked={selectedAuthors.has(a.name)} onChange={() => setSelectedAuthors(rowClickAuthor(a.name, authors.map(x => x.name), selectedAuthors, {}))} /></td>
                    <td className="py-2 pr-2 font-medium">{a.name}</td>
                    <td className="py-2 pr-2 text-slate-500">{a.videoCount}</td>
                    <td className="py-2 pr-2 text-slate-500">{formatMB(a.size)}</td>
                    <td className="py-2">
                      <button className="rounded px-2 py-1 text-xs text-brand-500 hover:bg-brand-50" onClick={() => void locateDir(joinPath(downloadDir, current, a.name), `作者「${a.name}」`)}>定位</button>
                      <button className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100" onClick={() => void exportUnder([current, a.name], `作者「${a.name}」`)}>导出</button>
                      <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50" onClick={() => void deleteAuthorNames([a.name])}>删除</button>
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

  // —— 一级页：品类表格 ——
  return (
    <Card title="文件管理">
      <div className="mb-2 flex items-center gap-3 text-xs">
        <button
          className={delBtnCls(selectedCats.size)}
          disabled={selectedCats.size === 0}
          onClick={() => void deleteCategories([...selectedCats])}
        >
          删除选中品类({selectedCats.size})
        </button>
        <button className={btn('secondary', 'sm')} onClick={() => void refresh()}>刷新</button>
        <button
          className={hintCls + (selectedCats.size ? ' text-slate-600 hover:bg-slate-100' : ' text-slate-300')}
          disabled={selectedCats.size === 0}
          onClick={() => void exportSelectedCats()}
        >
          导出选中品类({selectedCats.size})
        </button>
        <button className={btn('secondary', 'sm')} onClick={() => void exportAllDownloaded()}>导出全部已下载</button>
        <span className="text-sm font-medium tabular-nums text-slate-700">总大小：{formatSize(tree?.totalSize ?? 0)}</span>
        <span className="text-slate-300">提示：点品类行进入二级页，Ctrl 点选切换，Shift 点选范围，按住左键拖动框选替换</span>
      </div>
      {cats.length === 0 ? (
        <span className="text-sm text-slate-400">{tree === null ? '加载中…' : '下载目录还没有品类文件夹'}</span>
      ) : (
        <div
          ref={containerRef} data-testid="files-category-table" className="relative select-none overflow-auto"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onClick={handleContainerClick}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-400">
                <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allCats} onChange={() => setSelectedCats(allCats ? new Set() : new Set(cats.map(c => c.name)))} /></th>
                <th className="py-2 pr-2 font-medium">品类</th>
                <th className="py-2 pr-2 font-medium">视频数</th>
                <th className="py-2 pr-2 font-medium">总大小(MB)</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {cats.map(c => (
                <tr
                  key={c.name}
                  data-id={c.name}
                  data-selected={selectedCats.has(c.name) ? 'true' : undefined}
                  className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 ${selectedCats.has(c.name) ? 'bg-brand-50' : ''}`}
                  onClick={e => handleCatClick(c.name, e)}
                >
                  <td className="py-2 pr-1"><input type="checkbox" checked={selectedCats.has(c.name)} onChange={() => setSelectedCats(rowClickCat(c.name, cats.map(x => x.name), selectedCats, {}))} /></td>
                  <td className="py-2 pr-2 font-medium">{c.name}</td>
                  <td className="py-2 pr-2 text-slate-500">{c.videoCount}</td>
                  <td className="py-2 pr-2 text-slate-500">{formatMB(c.size)}</td>
                  <td className="py-2">
                    <button className="rounded px-2 py-1 text-xs text-brand-500 hover:bg-brand-50" onClick={() => void locateDir(joinPath(downloadDir, c.name), `品类「${c.name}」`)}>定位</button>
                    <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50" onClick={() => void deleteCategories([c.name])}>删除</button>
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
