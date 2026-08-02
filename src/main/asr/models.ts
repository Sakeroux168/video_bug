// src/main/asr/models.ts — 语音识别（ASR）模型的清单与下载
//
// 照搬 ainame 的 src/asr/models.js 改为 TypeScript（数值、双源、.part 原子写、体积/sha256 校验逐条一致）。
//
// 这个文件要能在两种环境下跑：Electron 主进程，和普通 Node 测试。
// 所以模块顶层不 import electron 的任何东西：modelsDir() 懒加载 electron，
// 纯逻辑测试用 setModelsRoot() 注入临时目录即可绕开。

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// ==========================
// ★ 模型版本：钉死 2024-07-17，不要"顺手升级"
// ==========================
//
// SenseVoice 有两个发布，新的那个反而不能用：
//
//   sense-voice-zh-en-ja-ko-yue-2024-07-17   use_itn=1 时【带标点】  ← 用这个
//   sense-voice-zh-en-ja-ko-yue-2025-09-09   更新，但【不支持标点】
//
// 标点对我们是刚需。一整段没标点的转写文本喂给 DeepSeek，它分不清
// 句子边界，起出来的标题会把两句话的意思揉成一句。
//
// 而且这个错不会报错 —— 模型照样能跑，只是转写结果里没有标点，
// 表现成"标题莫名其妙变差了"，非常难往这上面想。

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'

// HuggingFace 在国内经常连不上，所以多备几个源，按顺序试。
// hf-mirror 的路径和 HF 完全一致，只换域名。
const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

function hfSources(file: string): string[] {
  return HF_HOSTS.map(h => `${h}/${REPO}/resolve/main/${file}`)
}

// silero VAD 在 sherpa-onnx 的 GitHub Release 里。
// HF 上那些同名仓库放的是 v5 的各种量化导出，字节数对不上，
// 不能拿来当替代源 —— 版本不对会在运行时报出很难懂的形状错误。
// 好在它只有 640KB，实在下不动手工拷一个也就几秒钟的事。
const VAD_SOURCES = [
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
]

/** 一个模型文件的清单项：下载地址 + 期望体积 + （可选）sha256 校验 */
export interface AsrModelFile {
  key: string
  rel: string
  label: string
  bytes: number
  sha256: string
  sources: string[]
}

// bytes 和 sha256 都是实际量过的。
//
// 取 sha256 的正确姿势（这里踩过一次）：要从 HF 的 API 拿
//   https://huggingface.co/api/models/<repo>?blobs=true
// 里面 LFS 文件的 lfs.sha256 才是文件本身的 sha256。
//
// 不要用 resolve 端点 HEAD 回来的 ETag —— 那个是 HF 新的 Xet 存储的
// 内容哈希，长得和 sha256 一模一样（64 位十六进制），但值不一样，
// 拿它去校验会 100% 失败，而且报错看起来像是"文件被镜像站改过"。
//
// tokens.txt 不是 LFS 文件，API 只给 git blob 的 sha1，没有 sha256，
// 所以那个只校验体积。
export const FILES: AsrModelFile[] = [
  {
    key: 'model',
    rel: join('sense-voice', 'model.int8.onnx'),
    label: 'SenseVoice 识别模型',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    sources: hfSources('model.int8.onnx')
  },
  {
    key: 'tokens',
    rel: join('sense-voice', 'tokens.txt'),
    label: '词表',
    bytes: 315894,
    sha256: '',
    sources: hfSources('tokens.txt')
  },
  {
    key: 'vad',
    rel: 'silero_vad.onnx',
    label: '静音检测模型',
    bytes: 643854,
    sha256: '',
    sources: VAD_SOURCES
  }
]

// ==========================
// 模型根目录：测试注入优先，默认 electron userData 懒加载
// ==========================

let injectedRoot: string | null = null

/** 测试注入模型根目录（优先于 electron 的 userData/asr-models） */
export function setModelsRoot(dir: string): void {
  injectedRoot = dir
}

// 懒加载 electron：模块顶层不 import，纯逻辑测试 import 本文件不会触发 electron。
// 主进程 bundle 是 CJS，Rollup 会把 import.meta.url 转成 require('url').pathToFileURL(__filename)，
// 两种环境下 createRequire 都能拿到 Node 的 require。
const nodeRequire = createRequire(import.meta.url)

function electronUserData(): string {
  const electron = nodeRequire('electron') as { app?: { getPath(name: string): string } }
  const app = electron?.app
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('asr-models: electron app 不可用（modelsDir 默认分支只能在 Electron 主进程用；测试请 setModelsRoot 注入目录）')
  }
  return app.getPath('userData')
}

/** 模型根目录：setModelsRoot 注入过则用它，否则默认 {userData}/asr-models */
export function modelsDir(): string {
  if (injectedRoot !== null) return injectedRoot
  return join(electronUserData(), 'asr-models')
}

/** 模型文件绝对路径；未知 key 抛错 */
export function pathFor(key: string): string {
  const f = FILES.find(x => x.key === key)
  if (!f) throw new Error(`未知的模型文件: ${key}`)
  return join(modelsDir(), f.rel)
}

function totalBytes(): number {
  return FILES.reduce((a, f) => a + f.bytes, 0)
}

/** 单个文件的落盘状态 */
export interface ModelFileStatus {
  key: string
  label: string
  path: string
  expectBytes: number
  actualBytes: number
  ok: boolean
}

/** 整个模型目录的状态 */
export interface ModelsStatus {
  dir: string
  ready: boolean
  files: ModelFileStatus[]
  totalBytes: number
}

// ==========================
// 状态
// ==========================
// 只看体积，不算哈希 —— 算一遍 239MB 的 sha256 要好几秒，
// 而这个函数每次打开设置页都会调。哈希只在下载完那一刻校验。
//
// 体积对不上一律视为"没有"：残缺文件比没有文件更坏，
// 因为它会让"文件存在"的判断误以为一切正常，然后在加载模型时
// 抛出一堆看不懂的 onnxruntime 错误。
export function status(): ModelsStatus {
  const files: ModelFileStatus[] = FILES.map(f => {
    const p = join(modelsDir(), f.rel)
    let size = -1
    try { size = statSync(p).size } catch { /* 文件不存在 */ }
    return {
      key: f.key,
      label: f.label,
      path: p,
      expectBytes: f.bytes,
      actualBytes: size,
      ok: size === f.bytes
    }
  })

  return {
    dir: modelsDir(),
    ready: files.every(f => f.ok),
    totalBytes: totalBytes(),
    files
  }
}

// ==========================
// 下载
// ==========================

/** 下载/校验失败的专用错误；canceled 表示用户主动取消（不换源重试） */
export class DownloadError extends Error {
  canceled: boolean

  constructor(msg: string, opts: { canceled?: boolean } = {}) {
    super(msg)
    this.name = 'DownloadError'
    this.canceled = opts.canceled ?? false
  }
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) h.update(chunk as Buffer)
  return h.digest('hex')
}

interface DownloadProgress {
  key: string
  received: number
  total: number
}

// 一个文件、一个源。
// 先写 .part 再改名 —— 原子写。239MB 下到一半断网，留下的残缺文件
// 会被下次的"文件存在"判断当成好的，于是永远不会重下（缩略图那边已踩过这个坑）。
export async function downloadOne(
  spec: AsrModelFile,
  url: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
): Promise<string> {
  const dest = join(modelsDir(), spec.rel)
  const tmp = dest + '.part'

  await mkdir(dirname(dest), { recursive: true })

  const res = await fetch(url, { redirect: 'follow', signal: opts.signal })
  if (!res.ok) throw new DownloadError(`HTTP ${res.status} ${res.statusText}`)
  if (!res.body) throw new DownloadError(`响应无 body: ${url}`)

  const total = Number(res.headers.get('content-length')) || spec.bytes
  let received = 0
  const out = createWriteStream(tmp)

  // I-2：createWriteStream 之后【立即】挂 error 监听。磁盘满等写盘失败在循环结束前就会
  // emit 'error'；之前监听挂在循环结束后的 Promise 里 → 239MB 下到一半磁盘满时
  // 'error' 无监听 → 主进程 uncaught 崩溃。这里 error 直接 reject 下方 Promise，
  // 走外面 catch 统一 destroy + 清 .part。
  let resolveWriteDone!: () => void
  let rejectWriteDone!: (e: Error) => void
  const writeDone = new Promise<void>((resolve, reject) => {
    resolveWriteDone = resolve
    rejectWriteDone = reject
  })
  out.on('error', rejectWriteDone)

  try {
    for await (const chunk of res.body) {
      out.write(chunk)
      received += chunk.length
      if (opts.onProgress) opts.onProgress({ key: spec.key, received, total })
    }
    out.end(() => resolveWriteDone())
    await writeDone
  } catch (e) {
    out.destroy()
    await unlink(tmp).catch(() => {}) // 半成品不留
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') {
      throw new DownloadError('已取消', { canceled: true })
    }
    throw e
  }

  // 校验放在改名之前。校验不过就当这次下载失败，换下一个源。
  const st = await stat(tmp)
  if (st.size !== spec.bytes) {
    await unlink(tmp).catch(() => {})
    throw new DownloadError(`体积对不上：应为 ${spec.bytes} 字节，实际 ${st.size} 字节`)
  }

  if (spec.sha256) {
    const got = await sha256Of(tmp)
    if (got !== spec.sha256) {
      await unlink(tmp).catch(() => {})
      throw new DownloadError('校验和对不上（文件可能被镜像站改过或下载损坏）')
    }
  }

  await rename(tmp, dest)
  return dest
}

// 一个文件，把所有源依次试一遍。
export async function fetchFile(
  spec: AsrModelFile,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; onSource?: (s: { key: string; url: string }) => void } = {}
): Promise<string> {
  const errors: string[] = []

  for (const url of spec.sources) {
    if (opts.signal?.aborted) throw new DownloadError('已取消', { canceled: true })
    if (opts.onSource) opts.onSource({ key: spec.key, url })

    try {
      return await downloadOne(spec, url, { signal: opts.signal, onProgress: opts.onProgress })
    } catch (e) {
      if (e instanceof DownloadError && e.canceled) throw e
      errors.push(`${new URL(url).host}: ${(e as Error).message}`)
    }
  }

  throw new DownloadError(
    `${spec.label} 下载失败，${spec.sources.length} 个源都没成功：\n` +
    errors.map(x => `  · ${x}`).join('\n') +
    `\n\n可以手工把文件放到：\n  ${join(modelsDir(), spec.rel)}`
  )
}

/** 下载/整体进度（界面画一条总进度条用） */
export interface EnsureProgress {
  phase: 'start' | 'downloading' | 'done'
  label: string
  host?: string
  received: number
  total: number
}

/** ensureModels 结果：ModelsStatus + 本次下载/跳过的文件 */
export type EnsureModelsResult = ModelsStatus & {
  downloaded: string[]
  skipped: string[]
}

// 确保三个文件都在。已经在的跳过。
//
// onProgress 收到的是"整体进度"而不是单文件进度 —— 界面上要显示的是
// 一条进度条，让调用方自己去累加三个文件的字节数是没必要的负担。
export async function ensureModels(
  opts: { signal?: AbortSignal; onProgress?: (p: EnsureProgress) => void; force?: boolean } = {}
): Promise<EnsureModelsResult> {
  const st = status()
  if (st.ready && !opts.force) {
    return { ...st, downloaded: [], skipped: FILES.map(f => f.key) }
  }

  const need = opts.force ? FILES : FILES.filter(f => {
    const s = st.files.find(x => x.key === f.key)
    return !s || !s.ok
  })

  const doneBytes = FILES.filter(f => !need.includes(f)).reduce((a, f) => a + f.bytes, 0)
  const grand = totalBytes()
  let base = doneBytes
  const downloaded: string[] = []

  for (const spec of need) {
    await fetchFile(spec, {
      signal: opts.signal,
      onSource: s => opts.onProgress && opts.onProgress({
        phase: 'start', label: spec.label, host: new URL(s.url).host, received: base, total: grand
      }),
      onProgress: p => opts.onProgress && opts.onProgress({
        phase: 'downloading', label: spec.label, received: base + p.received, total: grand
      })
    })

    base += spec.bytes
    downloaded.push(spec.key)

    if (opts.onProgress) opts.onProgress({
      phase: 'done', label: spec.label, received: base, total: grand
    })
  }

  return { ...status(), downloaded, skipped: FILES.filter(f => !need.includes(f)).map(f => f.key) }
}
