import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import FileManager from '../../src/renderer/src/components/FileManager'
import type { FilesTree, FilesDirNode } from '../../src/shared/types'
import { installFakeApi } from '../helpers/fake-api'

// 文件管理 UI：通用文件夹视图。每一级都是「子文件夹 + 直属视频」的一张表，点文件夹行钻进去，
// 面包屑返回；定位/导出/删除对文件夹与视频都可用；删除走 confirm + api + 刷新。
// 不再有「品类页 / 作者页」的两级硬编码——归档层级四个开关各自可关，磁盘上是几层就显示几层。

const MB = 1024 * 1024

function node(name: string, over: Partial<FilesDirNode> = {}): FilesDirNode {
  return { name, videoCount: 0, size: 0, dirs: [], files: [], ...over }
}

/** 旧四层结构 + 根目录平铺视频 + 仅方向层级并存的一棵树 */
function makeTree(): FilesTree {
  const bucket = node('一分钟内', { videoCount: 1, size: 1 * MB, files: [{ name: 'deep.mp4', size: 1 * MB }] })
  const portrait = node('竖屏', { videoCount: 1, size: 1 * MB, dirs: [bucket] })
  const authorA = node('作者A', { videoCount: 2, size: 2 * MB, dirs: [portrait], files: [{ name: 'a2.mp4', size: 1 * MB }] })
  const authorB = node('作者B', { videoCount: 1, size: 1 * MB, files: [{ name: 'b1.mp4', size: 1 * MB }] })
  const food = node('美食', { videoCount: 3, size: 3 * MB, dirs: [authorA, authorB] })
  const landscape = node('横屏', { videoCount: 1, size: 0.5 * MB, files: [{ name: 'wide.mp4', size: 0.5 * MB }] })
  const root = node('', {
    videoCount: 5, size: 5.5 * MB,
    dirs: [food, landscape],
    files: [{ name: 'root.mp4', size: 2 * MB }]
  })
  return { root, totalSize: 5.5 * MB, downloadDir: 'D:/下载' }
}

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('tr')!
}

function rowButton(text: string, label: string): HTMLButtonElement {
  return within(rowOf(text)).getByRole('button', { name: label }) as HTMLButtonElement
}

describe('FileManager（文件管理 tab）', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function setup(notify: (t: string) => void = () => {}): Promise<void> {
    installFakeApi()
    vi.mocked(window.api.getFilesTree).mockResolvedValue(makeTree())
    render(<FileManager notify={notify} />)
    await screen.findByText('美食')
  }

  it('根目录：子文件夹与平铺视频同表可见（名称｜类型｜视频数｜大小），空状态提示', async () => {
    installFakeApi()
    vi.mocked(window.api.getFilesTree).mockResolvedValue({ root: node(''), totalSize: 0, downloadDir: 'D:/下载' })
    render(<FileManager notify={() => {}} />)
    await screen.findByText('下载目录还没有视频')
    vi.mocked(window.api.getFilesTree).mockResolvedValue(makeTree())
    fireEvent.click(screen.getByText('刷新'))
    await screen.findByText('美食')
    // 根目录直属 mp4 必须可见——这是修复的根因之一（旧实现顶层只认目录）
    expect(screen.getByText('root.mp4')).toBeTruthy()
    expect(within(rowOf('root.mp4')).getByText('视频')).toBeTruthy()
    expect(within(rowOf('美食')).getByText('文件夹')).toBeTruthy()
    expect(within(rowOf('美食')).getByText('3')).toBeTruthy() // 递归视频数
    expect(within(rowOf('美食')).getByText('3.0')).toBeTruthy() // MB
    expect(within(rowOf('横屏')).getByText('0.5')).toBeTruthy()
    // 「横屏」只是一个文件夹，不会被标成品类/作者
    expect(within(rowOf('横屏')).getByText('文件夹')).toBeTruthy()
    expect(screen.queryByText(/品类/)).toBeNull()
    expect(screen.queryByText(/作者$/)).toBeNull()
  })

  it('点文件夹行逐层钻取（面包屑显示当前位置），「返回上一级」逐层退回', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    expect(screen.getByText('当前文件夹：美食')).toBeTruthy()
    expect(screen.getByText('作者B')).toBeTruthy()
    expect(screen.queryByText('root.mp4')).toBeNull()

    fireEvent.click(screen.getByText('作者A'))
    await screen.findByText('竖屏')
    expect(screen.getByText('当前文件夹：美食 / 作者A')).toBeTruthy()
    expect(screen.getByText('a2.mp4')).toBeTruthy() // 子文件夹与直属视频并存

    fireEvent.click(screen.getByText('竖屏'))
    await screen.findByText('一分钟内')
    fireEvent.click(screen.getByText('一分钟内'))
    await screen.findByText('deep.mp4')
    expect(screen.getByText('当前文件夹：美食 / 作者A / 竖屏 / 一分钟内')).toBeTruthy()

    fireEvent.click(screen.getByText('← 返回上一级'))
    await screen.findByText('一分钟内')
    fireEvent.click(screen.getByText('← 返回上一级'))
    fireEvent.click(screen.getByText('← 返回上一级'))
    fireEvent.click(screen.getByText('← 返回上一级'))
    await screen.findByText('root.mp4')
    expect(screen.queryByText('← 返回上一级')).toBeNull() // 根目录没有上一级
  })

  it('行「删除」文件夹：confirm 确认 → deleteFileDir(相对段落) → 刷新', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileDir).mockResolvedValue({ ok: true, deleted: 3, filesRemoved: true })
    fireEvent.click(rowButton('美食', '删除'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('美食'))
    expect(window.api.deleteFileDir).toHaveBeenCalledWith(['美食'])
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 3 条'))
    expect(window.api.getFilesTree).toHaveBeenCalledTimes(2) // 删除后刷新
  })

  it('深层文件夹的「删除」带完整相对段落，不会误指向同名的顶层目录', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    fireEvent.click(screen.getByText('作者A'))
    await screen.findByText('竖屏')
    fireEvent.click(rowButton('竖屏', '删除'))
    expect(window.api.deleteFileDir).toHaveBeenCalledWith(['美食', '作者A', '竖屏'])
  })

  it('行「删除」视频：deleteFileVideo(相对段落)，根目录与深层都对', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileVideo).mockResolvedValue({ ok: true, deleted: 1, filesRemoved: true })
    fireEvent.click(rowButton('root.mp4', '删除'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('root.mp4'))
    expect(window.api.deleteFileVideo).toHaveBeenCalledWith(['root.mp4'])
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 1 条'))

    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    fireEvent.click(screen.getByText('作者A'))
    await screen.findByText('a2.mp4')
    fireEvent.click(rowButton('a2.mp4', '删除'))
    expect(window.api.deleteFileVideo).toHaveBeenCalledWith(['美食', '作者A', 'a2.mp4'])
  })

  it('行「删除」：confirm 取消则不调用', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await setup()
    fireEvent.click(rowButton('美食', '删除'))
    fireEvent.click(rowButton('root.mp4', '删除'))
    expect(window.api.deleteFileDir).not.toHaveBeenCalled()
    expect(window.api.deleteFileVideo).not.toHaveBeenCalled()
  })

  it('批量「删除选中(N)」：文件夹走 deleteFileDir、视频走 deleteFileVideo，条数汇总', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileDir).mockResolvedValue({ ok: true, deleted: 3, filesRemoved: true })
    vi.mocked(window.api.deleteFileVideo).mockResolvedValue({ ok: true, deleted: 1, filesRemoved: true })
    fireEvent.click(rowOf('美食').querySelector('input[type="checkbox"]')!)
    fireEvent.click(rowOf('root.mp4'), { ctrlKey: true })
    fireEvent.click(screen.getByText('删除选中(2)'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2'))
    await waitFor(() => {
      expect(window.api.deleteFileDir).toHaveBeenCalledWith(['美食'])
      expect(window.api.deleteFileVideo).toHaveBeenCalledWith(['root.mp4'])
    })
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已删除 4 条'))
  })

  it('未勾选时批量删除/导出按钮禁用', async () => {
    await setup()
    expect((screen.getByText('删除选中(0)') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('导出选中(0)') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Shift 点行范围选择（与其它表格语义一致）', async () => {
    await setup()
    fireEvent.click(rowOf('美食').querySelector('input[type="checkbox"]')!)
    fireEvent.click(rowOf('root.mp4'), { shiftKey: true })
    expect(screen.getByText('删除选中(3)')).toBeTruthy() // 美食、横屏、root.mp4
  })

  it('删除失败（ok:false deleted:0）→ 提示错误', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.deleteFileDir).mockResolvedValue({ ok: false, deleted: 0, error: '磁盘错误' })
    fireEvent.click(rowButton('美食', '删除'))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('删除失败：磁盘错误'))
  })

  it('根目录顶部显示总大小（GB/MB 自适应）；进入子文件夹显示「当前文件夹共 X」', async () => {
    await setup()
    expect(screen.getByText('总大小：5.5 MB')).toBeTruthy()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    expect(screen.getByText('当前文件夹共 3.0 MB')).toBeTruthy()
  })

  it('行「定位」文件夹：locateFileDir(下载目录/…段落) → notify 成功反馈；失败 → notify 错误', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: true })
    fireEvent.click(rowButton('美食', '定位'))
    expect(window.api.locateFileDir).toHaveBeenCalledWith('D:/下载/美食')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已在资源管理器中定位 文件夹「美食」'))

    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: false, error: '目录不存在' })
    fireEvent.click(rowButton('横屏', '定位'))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('定位失败：目录不存在'))
  })

  it('深层文件夹的「定位」拼完整路径', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateFileDir).mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    fireEvent.click(rowButton('作者A', '定位'))
    expect(window.api.locateFileDir).toHaveBeenCalledWith('D:/下载/美食/作者A')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已在资源管理器中定位 文件夹「作者A」'))
  })

  it('行「定位」视频：locateVideoFile(下载目录/…/文件名)', async () => {
    const notify = vi.fn()
    await setup(notify)
    vi.mocked(window.api.locateVideoFile).mockResolvedValue({ ok: true })
    fireEvent.click(rowButton('root.mp4', '定位'))
    expect(window.api.locateVideoFile).toHaveBeenCalledWith('D:/下载/root.mp4')
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已在资源管理器中定位 视频「root.mp4」'))
  })

  it('刷新后当前文件夹已不存在（被删）→ 自动退回最近仍存在的上级', async () => {
    await setup()
    fireEvent.click(screen.getByText('美食'))
    await screen.findByText('作者A')
    fireEvent.click(screen.getByText('作者A'))
    await screen.findByText('a2.mp4')
    // 磁盘上「作者A」没了，「美食」还在
    const pruned = makeTree()
    pruned.root.dirs[0].dirs = pruned.root.dirs[0].dirs.slice(1)
    vi.mocked(window.api.getFilesTree).mockResolvedValue(pruned)
    fireEvent.click(screen.getByText('刷新'))
    await screen.findByText('当前文件夹：美食')
    expect(screen.getByText('作者B')).toBeTruthy()
    expect(screen.queryByText('a2.mp4')).toBeNull()
  })
})
