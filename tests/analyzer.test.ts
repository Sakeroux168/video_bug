import { describe, it, expect } from 'vitest'
import { Analyzer, extractJsonObject } from '../src/main/analyzer'

describe('extractJsonObject', () => {
  it('从带前后缀文本中提取 JSON', () => {
    const text = '好的，结果如下：\n```json\n{"pass": true, "reason": "ok"}\n```\n 完毕'
    expect(extractJsonObject(text)).toEqual({ pass: true, reason: 'ok' })
  })
  it('无 JSON 返回 null', () => {
    expect(extractJsonObject('没有内容')).toBeNull()
  })
})

describe('Analyzer', () => {
  const cfg = { aiBaseUrl: 'https://api.test/v1', aiApiKey: 'k', aiModel: 'm' }

  it('judgeFilter 解析 pass=true', async () => {
    let capturedUrl: unknown
    let capturedHeaders: any
    let capturedBody: any
    const fetchImpl = (async (url: unknown, init?: any) => {
      capturedUrl = url
      capturedHeaders = init.headers
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass":true,"reason":"符合规则"}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    const v = await a.judgeFilter('标题 文案', '只要美食', 'cache-key')
    expect(v).toEqual({ pass: true, reason: '符合规则' })
    expect(capturedUrl).toBe('https://api.test/v1/chat/completions')
    expect(capturedHeaders.authorization).toBe('Bearer k')
    expect(capturedBody.model).toBe('m')
    expect(capturedBody.temperature).toBe(0)
    expect(capturedBody.response_format.type).toBe('json_object')
    expect(capturedBody.messages.length).toBe(2)
  })

  it('classify 解析分类与标签', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"category":"美食","tags":["探店","小吃"]}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    const r = await a.classify('标题 文案', 'cache-key')
    expect(r).toEqual({ category: '美食', tags: ['探店', '小吃'] })
  })

  it('classifyWithMedia 请求体含 image_url content 且无 response_format', async () => {
    let capturedBody: any
    const fetchImpl = (async (url: unknown, init?: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"category":"美食","tags":["探店"]}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    const r = await a.classifyWithMedia('标题 文案', [{ dataUrl: 'data:image/jpeg;base64,AAAA' }], 'media-key')
    expect(r).toEqual({ category: '美食', tags: ['探店'] })
    // 多模态端点很多不支持 response_format，这里特意不传
    expect(capturedBody.response_format).toBeUndefined()
    expect(capturedBody.messages.length).toBe(2)
    const content = capturedBody.messages[1].content
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toEqual({ type: 'text', text: '标题 文案' })
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } })
  })

  it('classifyWithMedia 同 cacheKey 结果缓存，不重复请求', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"category":"美食","tags":[]}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    await a.classifyWithMedia('a', [{ dataUrl: 'x' }], 'media-cache')
    await a.classifyWithMedia('a', [{ dataUrl: 'x' }], 'media-cache')
    expect(calls).toBe(1)
  })

  it('同 cacheKey 结果缓存，不重复请求', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass":true,"reason":"x"}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    await a.judgeFilter('a', '规则', 'same')
    await a.judgeFilter('a', '规则', 'same')
    expect(calls).toBe(1)
  })

  it('AI 返回非 JSON 时抛 parse 错误', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '抱歉我不懂' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    await expect(a.judgeFilter('x', '规则', 'k1')).rejects.toThrow()
  })
})
