import type { AppSettings } from '../shared/types'

export interface FilterVerdict { pass: boolean; reason: string }
export interface CategoryResult { category: string; tags: string[] }

/** 从任意文本中提取第一个平衡的 JSON 对象 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } } }
  }
  return null
}

type ChatResp = { choices: Array<{ message: { content: string } }> }

export class Analyzer {
  private cache = new Map<string, unknown>()
  constructor(
    private cfg: Pick<AppSettings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>,
    private fetchImpl: typeof fetch = fetch
  ) {}

  /** 发一次 chat/completions 请求并解析出 JSON 结果。body 是 model 之外的完整请求体 */
  private async requestChat(body: Record<string, unknown>): Promise<unknown> {
    const url = this.cfg.aiBaseUrl.replace(/\/+$/, '') + '/chat/completions'
    const res = await this.fetchImpl(url, {
      method: 'POST',
      // 60s 超时，防止 AI 端点挂起导致任务卡死；超时/失败抛错由调度器降级捕获
      signal: AbortSignal.timeout(60_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.aiApiKey}`
      },
      body: JSON.stringify({ model: this.cfg.aiModel, ...body })
    })
    if (!res.ok) throw new Error(`ai_http_${res.status}`)
    const data = (await res.json()) as ChatResp
    const content = data.choices?.[0]?.message?.content ?? ''
    const parsed = extractJsonObject(content)
    if (parsed === null) throw new Error('ai_parse')
    return parsed
  }

  private async chat(system: string, user: string): Promise<unknown> {
    return this.requestChat({
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  }

  async judgeFilter(text: string, rule: string, cacheKey: string): Promise<FilterVerdict> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as FilterVerdict
    const parsed = await this.chat(
      '你是视频筛选助手。根据用户规则判断一条视频是否保留。只输出 JSON：{"pass": true/false, "reason": "一句话理由"}。不要输出其他内容。',
      `筛选规则：${rule}\n\n视频信息：${text}`
    ) as Partial<FilterVerdict>
    const verdict: FilterVerdict = { pass: parsed.pass === true, reason: String(parsed.reason ?? '') }
    this.cache.set(cacheKey, verdict)
    return verdict
  }

  async classify(text: string, cacheKey: string): Promise<CategoryResult> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as CategoryResult
    const parsed = await this.chat(
      '你是视频分类助手。根据视频信息输出 JSON：{"category": "分类名(2-6字)", "tags": ["标签1","标签2"]}，最多5个标签。不要输出其他内容。',
      `视频信息：${text}`
    ) as Partial<CategoryResult>
    const result: CategoryResult = {
      category: String(parsed.category ?? '未分类'),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : []
    }
    this.cache.set(cacheKey, result)
    return result
  }

  /**
   * 多模态分类：文本 + 一列画面帧图一起发给模型判定品类。
   * 注意这里【不带 response_format】—— 很多多模态端点（智谱/豆包/OpenAI 自己）
   * 见 json_object 会直接 400，只能靠提示词约束 JSON 输出再手工解析。
   */
  async classifyWithMedia(
    text: string,
    images: Array<{ dataUrl: string }>,
    cacheKey: string
  ): Promise<CategoryResult> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as CategoryResult
    // content = 文本块 + 每张图一个 image_url 块（OpenAI 标准多模态写法）
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text }
    ]
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img.dataUrl } })
    }
    const parsed = await this.requestChat({
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是视频分类助手。根据视频的画面与文案判断这条视频的品类。' +
            '只输出 JSON：{"category": "分类名(2-6字)", "tags": ["标签1","标签2"]}，最多5个标签。不要输出其他内容。'
        },
        { role: 'user', content }
      ]
    }) as Partial<CategoryResult>
    const result: CategoryResult = {
      category: String(parsed.category ?? '未分类'),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : []
    }
    this.cache.set(cacheKey, result)
    return result
  }

  clearCache(): void { this.cache.clear() }
}
