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

  private async chat(system: string, user: string): Promise<unknown> {
    const url = this.cfg.aiBaseUrl.replace(/\/+$/, '') + '/chat/completions'
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.aiApiKey}`
      },
      body: JSON.stringify({
        model: this.cfg.aiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    })
    if (!res.ok) throw new Error(`ai_http_${res.status}`)
    const data = (await res.json()) as ChatResp
    const content = data.choices?.[0]?.message?.content ?? ''
    const parsed = extractJsonObject(content)
    if (parsed === null) throw new Error('ai_parse')
    return parsed
  }

  async judgeFilter(text: string, rule: string, cacheKey: string): Promise<FilterVerdict> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as FilterVerdict
    const parsed = await this.chat(
      '你是视频筛选助手。根据用户规则判断一条视频是否保留。只输出 JSON：{"pass": true/false, "reason": "一句话理由"}。不要输出其他内容。',
      `筛选规则：${rule}\n\n视频信息：${text}`
    ) as Partial<FilterVerdict>
    const verdict: FilterVerdict = { pass: Boolean(parsed.pass), reason: String(parsed.reason ?? '') }
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

  clearCache(): void { this.cache.clear() }
}
