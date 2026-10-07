// tests/asr-models.test.ts — ASR 模型清单与下载（Task 9）
//
// 纯逻辑测试：用 setModelsRoot 把模型目录指到临时目录，不触发 electron。
// 下载用全局 fetch 打桩，model 的 sha256 分支用小文件模拟（不真下 239MB）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, truncateSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  FILES, setModelsRoot, modelsDir, pathFor, status, ensureModels, downloadOne, fetchFile
} from '../src/main/asr/models'
import type { AsrModelFile } from '../src/main/asr/models'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asr-models-'))
  setModelsRoot(dir)
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 用一个固定 fetch 桩替换全局 fetch，跑完还原 */
function withFetch(fn: typeof fetch, run: () => Promise<void>): Promise<void> {
  const g = globalThis as { fetch: typeof fetch }
  const orig = g.fetch
  g.fetch = fn
  return run().finally(() => { g.fetch = orig })
}

/** 在 root 下造出体积正确的三个文件（truncate 秒开，不用真写 239MB） */
function placeFiles(root: string): void {
  for (const f of FILES) {
    const p = join(root, f.rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '')
    truncateSync(p, f.bytes)
  }
}

/** 递归收集目录里所有 .part 文件（应始终为空） */
function collectParts(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.part')) out.push(p)
    }
  }
  walk(root)
  return out
}

/** 造一个小体积的 model spec（sha256 与真实内容一致），模拟"不用真下 239MB" */
function smallModelSpec(over: Partial<AsrModelFile> = {}): { spec: AsrModelFile; content: Buffer } {
  const content = Buffer.from('fake-model-file-with-correct-hash')
  const spec: AsrModelFile = {
    key: 'model', rel: join('sense-voice', 'model.int8.onnx'), label: 'SenseVoice 识别模型',
    bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
    sources: ['https://huggingface.test/model.int8.onnx'],
    ...over
  }
  return { spec, content }
}

describe('status', () => {
  it('空目录 → 三个文件 ok:false、ready:false', () => {
    const st = status()
    expect(st.ready).toBe(false)
    expect(st.files).toHaveLength(3)
    expect(st.dir).toBe(modelsDir())
    expect(st.totalBytes).toBe(FILES.reduce((a, f) => a + f.bytes, 0))
    for (const f of st.files) {
      expect(f.ok).toBe(false)
      expect(f.actualBytes).toBe(-1)
    }
  })

  it('放入体积正确的文件 → ready:true', () => {
    placeFiles(dir)
    const st = status()
    expect(st.ready).toBe(true)
    for (const f of st.files) {
      expect(f.ok).toBe(true)
      expect(f.actualBytes).toBe(f.expectBytes)
    }
  })

  it('体积差一字节 → 视为没准备好', () => {
    const tok = FILES.find(f => f.key === 'tokens')!
    const p = join(dir, tok.rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, Buffer.alloc(tok.bytes - 1, 0)) // 少 1 字节
    expect(status().ready).toBe(false)
  })

  it('pathFor 未知 key 抛错、已知 key 返回注入目录下的绝对路径', () => {
    expect(() => pathFor('nope')).toThrow(/未知的模型文件/)
    for (const f of FILES) {
      const p = pathFor(f.key)
      expect(p.startsWith(dir)).toBe(true)
      expect(p.endsWith(f.rel)).toBe(true)
    }
  })
})

describe('downloadOne', () => {
  it('体积对 + sha256 对 → 原子写成功落地、无 .part 残留', async () => {
    const { spec, content } = smallModelSpec()
    await withFetch(
      (async () => new Response(new Uint8Array(content), { status: 200 })) as typeof fetch,
      async () => { await downloadOne(spec, spec.sources[0]) }
    )
    expect(readFileSync(join(dir, spec.rel))).toEqual(content)
    expect(collectParts(dir)).toHaveLength(0)
  })

  it('体积对但 sha256 不符 → 抛错且不 rename、不残留 .part', async () => {
    const { content } = smallModelSpec()
    const spec = smallModelSpec({
      sha256: '0000000000000000000000000000000000000000000000000000000000000000' // 故意填错
    }).spec
    await withFetch(
      (async () => new Response(new Uint8Array(content), { status: 200 })) as typeof fetch,
      async () => {
        await expect(downloadOne(spec, spec.sources[0])).rejects.toThrow(/校验和/)
      }
    )
    expect(existsSync(join(dir, spec.rel))).toBe(false) // 不 rename
    expect(collectParts(dir)).toHaveLength(0) // 不残留 .part
  })

  it('体积不对 → 抛体积错误且不 rename', async () => {
    const { spec } = smallModelSpec({ bytes: 9999 })
    await withFetch(
      (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch,
      async () => {
        await expect(downloadOne(spec, spec.sources[0])).rejects.toThrow(/体积对不上/)
      }
    )
    expect(existsSync(join(dir, spec.rel))).toBe(false)
    expect(collectParts(dir)).toHaveLength(0)
  })
})

describe('fetchFile', () => {
  it('首个源失败 → 换源重试成功', async () => {
    const { spec, content } = smallModelSpec({
      sources: ['https://bad.test/model.int8.onnx', 'https://good.test/model.int8.onnx']
    })
    const fn = (async (url: unknown) => {
      if (String(url).includes('bad.test')) return new Response('nope', { status: 404 })
      return new Response(new Uint8Array(content), { status: 200 })
    }) as typeof fetch
    await withFetch(fn, async () => { await fetchFile(spec) })
    expect(readFileSync(join(dir, spec.rel))).toEqual(content)
    expect(collectParts(dir)).toHaveLength(0)
  })

  it('所有源都失败 → 抛聚合错误，列出处', async () => {
    const { spec } = smallModelSpec({
      sources: ['https://bad.test/model.int8.onnx', 'https://worse.test/model.int8.onnx']
    })
    const fn = (async () => new Response('nope', { status: 500 })) as typeof fetch
    await withFetch(fn, async () => {
      await expect(fetchFile(spec)).rejects.toThrow(/下载失败/)
      await expect(fetchFile(spec)).rejects.toThrow(/bad\.test|worse\.test/)
    })
    expect(collectParts(dir)).toHaveLength(0)
  })
})

describe('ensureModels', () => {
  it('三文件就绪 → 直接返回，不发下载请求', async () => {
    placeFiles(dir)
    await withFetch(
      (async () => { throw new Error('不应发起下载请求') }) as typeof fetch,
      async () => {
        const r = await ensureModels()
        expect(r.ready).toBe(true)
        expect(r.downloaded).toEqual([])
        expect(r.skipped).toEqual(FILES.map(f => f.key))
      }
    )
  })

  it('体积不对 → 报错（换源全失败）且不残留 .part、不 rename', async () => {
    await withFetch(
      (async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: { 'content-length': '5' }
      })) as typeof fetch,
      async () => {
        await expect(ensureModels()).rejects.toThrow(/下载失败/)
      }
    )
    expect(existsSync(join(dir, FILES[0].rel))).toBe(false) // model 没落地
    expect(collectParts(dir)).toHaveLength(0) // 不残留 .part
  })

  it('部分就绪 → 只补缺失文件，已就绪的不发请求', async () => {
    // 先放好 tokens/vad，model 缺失 → ensureModels 只该尝试补 model
    for (const f of FILES.filter(x => x.key !== 'model')) {
      const p = join(dir, f.rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '')
      truncateSync(p, f.bytes)
    }
    const fetched: string[] = []
    const fn = (async (url: unknown) => {
      fetched.push(String(url))
      throw new Error('mock 下载失败')
    }) as typeof fetch
    await withFetch(fn, async () => {
      await expect(ensureModels()).rejects.toThrow()
    })
    // 只尝试 model 的两个源，tokens/vad 没发请求
    expect(fetched).toHaveLength(2)
    expect(fetched.every(u => u.includes('model.int8.onnx'))).toBe(true)
  })
})
