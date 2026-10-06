import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { FilesTree, FilesDirNode } from '../../../shared/types'
import { Card, btn } from './ui'
import { useMarqueeSelect } from './useMarqueeSelect'
import { useTableSelection } from './useTableSelection'
import { buildVideosCsv, toVideoExportRows, csvFileName, filterVideosUnder } from './videosCsv'
import { saveCsvFile } from './csvSave'
import type { Notify } from './Notice'

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

/** 按相对段落在树里找节点；任一段落不存在 → null */
function findNode(root: FilesDirNode, cwd: string[]): FilesDirNode | null {
  let node: FilesDirNode | null = root
  for (const seg of cwd) {
    node = node.dirs.find(d => d.name === seg) ?? null
    if (!node) return null
  }
  return node
}

/** 当前文件夹里的一行：子文件夹或直属视频。id 带类型前缀，供勾选/框选区分 */
interface Entry { id: string; kind: 'dir' | 'file'; name: string; videoCount: number; size: number }

function entriesOf(node: FilesDirNode): Entry[] {
  return [
    ...node.dirs.map(d => ({ id: `dir:${d.name}`, kind: 'dir' as const, name: d.name, videoCount: d.videoCount, size: d.size })),
    ...node.files.map(f => ({ id: `file:${f.name}`, kind: 'file' as const, name: f.name, videoCount: 1, size: f.size }))
  ]
}

/**
 * 文件管理 tab：下载目录的通用文件夹视图（以磁盘为准）。
 * 每一级都是「子文件夹 + 直属视频」的一张表：点文件夹行钻进去、「返回上一级」退回，面包屑显示当前位置。
 * 不假定任何一层是品类或作者——归档层级四个开关各自可关，磁盘上是几层就显示几层，
 * 根目录直接平铺的视频与子文件夹同样可见。
 * 定位/导出/删除对文件夹与视频都可用；删除 = 放进回收站（文件夹整个放）+ DB 联动，window.confirm 二次确认，删除后刷新。
 */
export default function FileManager({ notify }: { notify: Notify }) {
  const [tree, setTree] = useState<FilesTree | null>(null)
  const [cwd, setCwd] = useState<string[]>([]) // 当前文件夹的相对段落（[] = 下载目录根）
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    const next = await api.getFilesTree()
    setTree(next)
    // 当前文件夹可能已被删掉（本页删除或外部删除）：退回最近仍存在的上级，而不是停在一张空表上
    setCwd(prev => {
      let valid = prev
      while (valid.length > 0 && !findNode(next.root, valid)) valid = valid.slice(0, -1)
      return valid
    })
  }

  const downloadDir = tree?.downloadDir ?? ''
  const node = tree ? findNode(tree.root, cwd) : null
  const entries = node ? entriesOf(node) : []
  const entryIds = entries.map(e => e.id)

  // 平台显示名来自 platforms:list（源头是各适配器的 displayName），未知平台回落原始名
  const [platformNames, setPlatformNames] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.listPlatforms().then(list => setPlatformNames(Object.fromEntries(list.map(p => [p.name, p.displayName]))))
  }, [])

  /**
   * 导出视频数据表。segments 为空 = 全部已下载；给了就只导那个文件夹（或那一个视频文件）底下的。
   * 按路径前缀筛而不是按品类/作者字段筛：归档层级可配，目录结构会变，
   * 按路径判永远和用户在这一页看到的一致。
   */
  async function exportUnder(segments: string[], label: string): Promise<void> {
    const all = await api.listDownloadedVideos().catch(() => { notify('读取视频数据失败，请稍后重新导出'); return null })
    if (!all) return
    const rows = segments.length === 0 ? all : filterVideosUnder(all, downloadDir, segments)
    if (rows.length === 0) {
      notify(`${label}没有已下载的视频，没有可导出的数据`)
      return
    }
    const csv = buildVideosCsv(toVideoExportRows(rows, name => platformNames[name] ?? name))
    await saveCsvFile(csv, csvFileName(`视频数据-${label}`), rows.length, notify)
  }

  /** 导出勾选的多项（文件夹按目录取、视频按文件取），合并成一张表 */
  async function exportSelected(): Promise<void> {
    const picked = entries.filter(e => selected.has(e.id))
    const all = await api.listDownloadedVideos().catch(() => { notify('读取视频数据失败，请稍后重新导出'); return null })
    if (!all) return
    const rows = picked.flatMap(e => filterVideosUnder(all, downloadDir, [...cwd, e.name]))
    if (rows.length === 0) {
      notify('选中的项目下没有已下载的视频，没有可导出的数据')
      return
    }
    const csv = buildVideosCsv(toVideoExportRows(rows, name => platformNames[name] ?? name))
    await saveCsvFile(csv, csvFileName(`视频数据-${picked.length} 项`), rows.length, notify)
  }

  // 普通点击：文件夹钻取 / 视频排他选择；Ctrl 切换，Shift 范围（与作者表格语义一致）
  const { rowClick } = useTableSelection<string>()

  // 拖拽框选（纯替换：松手后选中集合 = 框内命中行，框外一律取消）
  const { containerRef, marquee, didDragRef, onMouseDown, onMouseMove, endDrag } = useMarqueeSelect<string>({
    stringIds: true, // 行 data-id 是带类型前缀的名字（字符串）
    onSelect: ids => setSelected(new Set(ids))
  })

  function enter(name: string): void {
    setCwd([...cwd, name])
    setSelected(new Set())
  }

  function goUp(): void {
    setCwd(cwd.slice(0, -1))
    setSelected(new Set())
  }

  function handleRowClick(entry: Entry, e: React.MouseEvent): void {
    if (didDragRef.current) return
    if ((e.target as HTMLElement).closest('button, a, input')) return
    if (e.ctrlKey || e.shiftKey || entry.kind === 'file') {
      setSelected(rowClick(entry.id, entryIds, selected, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey }))
      return
    }
    enter(entry.name)
  }

  // 点容器内空白区域（非行、非交互元素）→ 清空选择；拖拽后的 click 跳过
  function handleContainerClick(e: React.MouseEvent): void {
    if (didDragRef.current) return
    const t = e.target as HTMLElement
    if (t.closest('tr, button, a, input')) return
    setSelected(new Set())
  }

  // 批量删除：前端循环调单删（主进程逐条防护 + DB 联动），汇总条数与错误
  async function deleteEntries(items: Entry[]): Promise<void> {
    if (!items.length) return
    const label = items.length === 1
      ? `${items[0].kind === 'dir' ? '文件夹' : '视频'}「${items[0].name}」`
      : `选中的 ${items.length} 项`
    const detail = items.some(i => i.kind === 'dir') ? '文件夹里的全部文件会一起删除，' : ''
    if (!window.confirm(`确定删除${label}？${detail}文件会放进回收站，需要时可以从回收站还原`)) return
    let deleted = 0
    let err: string | null = null
    for (const item of items) {
      const segments = [...cwd, item.name]
      const r = item.kind === 'dir' ? await api.deleteFileDir(segments) : await api.deleteFileVideo(segments)
      deleted += r.deleted
      if (!r.ok && r.error) err = r.error
    }
    setSelected(new Set())
    if (err) notify(deleted > 0 ? `已删除 ${deleted} 条，部分失败：${err}` : `删除失败：${err}`)
    else notify(`已删除 ${deleted} 条`)
    void refresh()
  }

  // 定位：主进程校验（路径防护 + 存在性）后调资源管理器选中；结果 notify 反馈
  async function locate(entry: Entry): Promise<void> {
    const path = joinPath(downloadDir, ...cwd, entry.name)
    const r = entry.kind === 'dir' ? await api.locateFileDir(path) : await api.locateVideoFile(path)
    if (r.ok) notify(`已在资源管理器中定位 ${entry.kind === 'dir' ? '文件夹' : '视频'}「${entry.name}」`)
    else notify(`定位失败：${r.error ?? '未知错误'}`)
  }

  const allSelected = entries.length > 0 && entries.every(e => selected.has(e.id))
  const selectedEntries = entries.filter(e => selected.has(e.id))
  const atRoot = cwd.length === 0
  const cwdLabel = cwd.join(' / ')

  const hintCls = 'rounded-md px-2 py-1 text-xs'
  const delBtnCls = (n: number) => `${hintCls} ${n ? 'bg-danger-50 text-danger-600 hover:bg-danger-100' : 'text-slate-300'}`
  const exportBtnCls = (n: number) => `${hintCls} ${n ? 'text-slate-600 hover:bg-slate-100' : 'text-slate-300'}`

  return (
    <Card title="文件管理">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        {!atRoot && (
          <button className={btn('secondary', 'sm')} onClick={goUp}>← 返回上一级</button>
        )}
        <span className="text-sm font-medium text-slate-700">
          {atRoot ? '当前位置：下载目录' : `当前文件夹：${cwdLabel}`}
        </span>
        <span className="text-xs tabular-nums text-slate-500">
          {atRoot ? `总大小：${formatSize(tree?.totalSize ?? 0)}` : `当前文件夹共 ${formatSize(node?.size ?? 0)}`}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <button
          className={delBtnCls(selected.size)}
          disabled={selected.size === 0}
          onClick={() => void deleteEntries(selectedEntries)}
        >
          删除选中({selected.size})
        </button>
        <button
          className={exportBtnCls(selected.size)}
          disabled={selected.size === 0}
          onClick={() => void exportSelected()}
        >
          导出选中({selected.size})
        </button>
        {atRoot
          ? <button className={btn('secondary', 'sm')} onClick={() => void exportUnder([], '全部已下载')}>导出全部已下载</button>
          : <button className={btn('secondary', 'sm')} onClick={() => void exportUnder(cwd, `文件夹「${cwd[cwd.length - 1]}」`)}>导出当前文件夹</button>}
        <button className={btn('secondary', 'sm')} onClick={() => void refresh()}>刷新</button>
        <span className="text-slate-300">提示：点文件夹行进入，点视频行选中，Ctrl 点选切换，Shift 点选范围，点空白取消，按住左键拖动框选替换</span>
      </div>
      {entries.length === 0 ? (
        <span className="text-sm text-slate-400">
          {tree === null ? '加载中…' : atRoot ? '下载目录还没有视频' : '该文件夹下没有视频或子文件夹'}
        </span>
      ) : (
        <div
          ref={containerRef} data-testid="files-table" className="relative select-none overflow-auto"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onClick={handleContainerClick}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-400">
                <th className="w-8 py-2 pr-1 font-medium"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(entryIds))} /></th>
                <th className="py-2 pr-2 font-medium">名称</th>
                <th className="py-2 pr-2 font-medium">类型</th>
                <th className="py-2 pr-2 font-medium">视频数</th>
                <th className="py-2 pr-2 font-medium">大小(MB)</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr
                  key={entry.id}
                  data-id={entry.id}
                  data-selected={selected.has(entry.id) ? 'true' : undefined}
                  className={`cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 ${selected.has(entry.id) ? 'bg-brand-50' : ''}`}
                  onClick={e => handleRowClick(entry, e)}
                >
                  <td className="py-2 pr-1"><input type="checkbox" checked={selected.has(entry.id)} onChange={() => setSelected(rowClick(entry.id, entryIds, selected, { checkbox: true }))} /></td>
                  <td className="py-2 pr-2 font-medium">{entry.name}</td>
                  <td className="py-2 pr-2 text-slate-500">{entry.kind === 'dir' ? '文件夹' : '视频'}</td>
                  <td className="py-2 pr-2 text-slate-500">{entry.videoCount}</td>
                  <td className="py-2 pr-2 text-slate-500">{formatMB(entry.size)}</td>
                  <td className="py-2">
                    <button className="rounded px-2 py-1 text-xs text-brand-500 hover:bg-brand-50" onClick={() => void locate(entry)}>定位</button>
                    {entry.kind === 'dir' && (
                      <button className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100" onClick={() => void exportUnder([...cwd, entry.name], `文件夹「${entry.name}」`)}>导出</button>
                    )}
                    <button className="rounded px-2 py-1 text-xs text-danger-600 hover:bg-danger-50" onClick={() => void deleteEntries([entry])}>删除</button>
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
