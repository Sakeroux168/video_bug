// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  douyinAdapter, collectAwemeList, drainDurationDiags,
  FILTER_SELECTORS, FILTER_OPTION_NAMES, resolveSelector, optionLabel
} from '../src/main/adapters/douyin'

const AWEME = {
  aweme_id: '7300000000000000001',
  desc: '美食探店 第3期',
  author: { sec_uid: 'MS4wLjABAAAA1', nickname: '探店小王' },
  video: { play_addr: { url_list: ['https://v.douyin.com/xxx/playwm/?foo=bar'] } },
  duration: 45000, // ms
  create_time: 1710000000,
  statistics: { digg_count: 1234 }
}

describe('douyinAdapter.parseApiJson', () => {
  it('解析搜索接口结构（data[].aweme_list）', () => {
    const json = { status_code: 0, data: [{ aweme_list: [AWEME] }] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/search/item/', json)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      awemeId: '7300000000000000001', title: '美食探店 第3期',
      authorSecUid: 'MS4wLjABAAAA1', authorNickname: '探店小王',
      authorHomeUrl: 'https://www.douyin.com/user/MS4wLjABAAAA1',
      playUrl: 'https://v.douyin.com/xxx/playwm/?foo=bar',
      durationSec: 45, publishTime: 1710000000, likes: 1234
    })
  })

  it('解析作者主页接口结构（顶层 aweme_list）', () => {
    const json = { aweme_list: [AWEME], has_more: 0 }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/aweme/post/', json)
    expect(items).toHaveLength(1)
  })

  it('过滤掉无播放地址/无 id 的脏数据', () => {
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [AWEME, { aweme_id: '', desc: 'x' }] })
    expect(items).toHaveLength(1)
  })
})

describe('douyinAdapter 时长多候选解析（毫秒→秒）', () => {
  it('顶层无 duration 时回退 video.duration', () => {
    const aweme = { ...AWEME, duration: undefined, video: { ...AWEME.video, duration: 45000 } }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items).toHaveLength(1)
    expect(items[0].durationSec).toBe(45)
  })

  it('顶层 duration 优先于 video.duration（候选顺序正确）', () => {
    const aweme = { ...AWEME, video: { ...AWEME.video, duration: 60000 } }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items).toHaveLength(1)
    expect(items[0].durationSec).toBe(45)
  })

  it('顶层与 video 皆无时长时解析为 0', () => {
    const aweme = { ...AWEME, duration: undefined }
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items[0].durationSec).toBe(0)
  })
})

describe('douyinAdapter 0 时长诊断（drainDurationDiags）', () => {
  it('解析出 0 时长有效条目时记录其顶层字段名', () => {
    drainDurationDiags() // 先清空历史诊断
    const aweme = { ...AWEME }
    delete (aweme as Record<string, unknown>).duration // 真实接口无该字段时键不存在
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [aweme] })
    expect(items[0].durationSec).toBe(0)
    const diags = drainDurationDiags()
    expect(diags).toHaveLength(1)
    expect(diags[0].topKeys).toEqual(expect.arrayContaining(['aweme_id', 'desc', 'author', 'video', 'create_time', 'statistics']))
    expect(diags[0].topKeys).not.toContain('duration')
  })

  it('时长正常时不产生诊断', () => {
    drainDurationDiags()
    douyinAdapter.parseApiJson('https://x/', { aweme_list: [{ ...AWEME }] })
    expect(drainDurationDiags()).toHaveLength(0)
  })
})

describe('collectAwemeList', () => {
  it('深度扫描任意嵌套中的 aweme_list 数组', () => {
    const json = { a: { b: { aweme_list: [AWEME] } } }
    expect(collectAwemeList(json)).toHaveLength(1)
  })
})

describe('douyinAdapter.normalizePlayUrl', () => {
  it('playwm 替换为 play', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/playwm/1')).toBe('https://a/play/1')
  })
  it('不做 _watermark 字符串替换（避免改坏 CDN 文件名导致黑屏）', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/x_watermark_100')).toBe('https://a/x_watermark_100')
  })
  it('已是无水印则原样返回', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/play/1')).toBe('https://a/play/1')
  })
})

describe('douyinAdapter URL 构造', () => {
  it('buildSearchUrl 编码关键词', () => {
    expect(douyinAdapter.buildSearchUrl('美食 探店', { timeRange: 'all', duration: 'all', targetCount: 200 }))
      .toBe('https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F%20%E6%8E%A2%E5%BA%97')
  })
  it('buildAuthorUrl 拼接 sec_uid', () => {
    expect(douyinAdapter.buildAuthorUrl('SEC123')).toBe('https://www.douyin.com/user/SEC123')
  })
})

describe('douyinAdapter 解析新 general/search 结构', () => {
  it('data 直接放视频对象（无 aweme_list 键）', () => {
    const json = { status_code: 0, cursor: 1, data: [AWEME, { ...AWEME, aweme_id: '7300000000000000002' }] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/general/search/single/', json)
    expect(items).toHaveLength(2)
    expect(items[1].awemeId).toBe('7300000000000000002')
  })
  it('视频嵌套在任意层级的键下也能收集', () => {
    const json = { status_code: 0, extra: { data: { items: [AWEME] } } }
    expect(collectAwemeList(json)).toHaveLength(1)
  })
})

describe('douyinAdapter 解析新版卡片结构（aweme_info 包装）', () => {
  it('data[] 是卡片，视频在 aweme_info 里', () => {
    const card = (id: string) => ({ type: 1, doc_type: 0, aweme_info: { ...AWEME, aweme_id: id } })
    const json = { status_code: 0, data: [card('7300000000000000011'), card('7300000000000000012')] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/general/search/single/', json)
    expect(items).toHaveLength(2)
    expect(items[0].awemeId).toBe('7300000000000000011')
    expect(items[1].awemeId).toBe('7300000000000000012')
  })
})

describe('FILTER_SELECTORS 多候选结构（哈希类名过期加固）', () => {
  it('按钮：css 哈希类优先，文字"筛选"兜底', () => {
    expect(FILTER_SELECTORS.button).toEqual([
      { type: 'css', sel: 'span.bR4uhU1W' },
      { type: 'text', text: '筛选' }
    ])
  })

  it('面板：css 哈希类优先，文字含"排序依据"/"视频时长"兜底', () => {
    expect(FILTER_SELECTORS.panel).toEqual([
      { type: 'css', sel: 'div.IMWRHJOg' },
      { type: 'contains', contains: ['排序依据', '视频时长'] }
    ])
  })

  it('选项：语义属性 data-index1/2 优先，面板内文字匹配兜底', () => {
    expect(FILTER_SELECTORS.option(2, 2)).toEqual([
      { type: 'css', sel: 'span[data-index1="2"][data-index2="2"]' },
      { type: 'text', text: '1-5分钟' }
    ])
  })

  it('未知组/选项索引只保留属性候选（无文字可兜底）', () => {
    expect(FILTER_SELECTORS.option(9, 9)).toEqual([
      { type: 'css', sel: 'span[data-index1="9"][data-index2="9"]' }
    ])
  })
})

describe('选项名映射表（FILTER_OPTION_NAMES）', () => {
  it('各维度 0=不限，其余与面板文案一致', () => {
    expect(FILTER_OPTION_NAMES[1]).toEqual({ 0: '不限', 1: '一天内', 2: '一周内', 3: '半年内' })
    expect(FILTER_OPTION_NAMES[2]).toEqual({ 0: '不限', 1: '1分钟以下', 2: '1-5分钟', 3: '5分钟以上' })
    expect(FILTER_OPTION_NAMES[3]).toEqual({ 0: '不限', 1: '关注的人', 2: '最近看过', 3: '还未看过' })
    expect(FILTER_OPTION_NAMES[4]).toEqual({ 0: '不限', 1: '视频', 2: '图文' })
  })

  it('optionLabel 打点描述含组名与选项名', () => {
    expect(optionLabel(2, 2)).toContain('1-5分钟')
    expect(optionLabel(3, 1)).toContain('关注的人')
  })
})

describe('resolveSelector 候选解析（依次尝试、命中即返回）', () => {
  function dom() {
    const doc = {
      querySelector: (sel: string): unknown => document.querySelector(sel),
      querySelectorAll: (sel: string): unknown[] => Array.from(document.querySelectorAll(sel))
    }
    const textOf = (el: unknown): string => ((el as Element).textContent ?? '').trim()
    return { doc, textOf }
  }

  it('css 候选命中优先于文字候选', () => {
    document.body.innerHTML = '<span class="bR4uhU1W">筛选</span>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null)
    expect(r.index).toBe(0)
    expect((r.el as Element).className).toBe('bR4uhU1W')
  })

  it('css 缺失时文字候选兜底命中', () => {
    document.body.innerHTML = '<div><span>筛选</span></div>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null)
    expect(r.el).not.toBeNull()
    expect(r.index).toBe(1)
  })

  it('文字候选精确匹配：混有其他文本的容器不命中', () => {
    document.body.innerHTML = '<span>筛选按钮</span><span>筛选</span>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null)
    expect(r.index).toBe(1)
    expect((r.el as Element).textContent).toBe('筛选')
  })

  it('全部候选未命中返回 el=null / index=-1', () => {
    document.body.innerHTML = '<div>页面无相关元素</div>'
    const { doc, textOf } = dom()
    expect(resolveSelector(FILTER_SELECTORS.button, doc, textOf, null)).toEqual({ el: null, index: -1 })
    expect(resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null)).toEqual({ el: null, index: -1 })
  })

  it('contains 候选取「命中关键词最多、文本最短」的容器（面板最小公共容器）', () => {
    document.body.innerHTML =
      '<div id="page"><div id="panel"><div id="l1">排序依据</div><div id="l2">视频时长</div></div></div>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null)
    expect(r.index).toBe(1)
    expect((r.el as Element).id).toBe('panel')
  })

  it('contains 仅命中单个关键词时取包含该词的最小容器（不误命中整页）', () => {
    document.body.innerHTML = '<div id="page"><div id="panel">排序依据 其它内容</div></div>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null)
    expect(r.index).toBe(1)
    expect((r.el as Element).id).toBe('panel')
  })

  it('scope 限定：文字选项只在面板内查找（页面上同名文本不干扰）', () => {
    document.body.innerHTML =
      '<div id="page"><span>一天内</span></div>' +
      '<div id="panel"><span>排序依据</span><span>视频时长</span><span>一天内</span></div>'
    const { doc, textOf } = dom()
    const panel = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null)
    expect(panel.el).not.toBeNull()
    const r = resolveSelector(FILTER_SELECTORS.option(1, 1), doc, textOf, panel.el)
    expect(r.index).toBe(1) // 页面无 data-index1/2 → css 未命中，文字兜底
    expect((r.el as Element).parentElement?.id).toBe('panel')
  })

  it('scope 内 css 候选命中优先', () => {
    document.body.innerHTML =
      '<div id="panel"><span data-index1="2" data-index2="3">5分钟以上</span><span>5分钟以上</span></div>'
    const { doc, textOf } = dom()
    const panel = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null)
    const r = resolveSelector(FILTER_SELECTORS.option(2, 3), doc, textOf, panel.el)
    expect(r.index).toBe(0)
    expect((r.el as Element).getAttribute('data-index1')).toBe('2')
  })

  it('resolveSelector 源码自包含：toString 可独立求值（页面脚本嵌入用，无闭包依赖）', () => {
    const src = resolveSelector.toString()
    // 不引用模块级常量（标签列表必须内联在函数体内，页面脚本无法解析外部作用域）
    expect(src).not.toMatch(/TEXT_TAGS|CONTAINER_TAGS/)
    const standalone = new Function(`return (${src})`)() as typeof resolveSelector
    document.body.innerHTML = '<span class="bR4uhU1W">筛选</span>'
    const { doc, textOf } = dom()
    const r = standalone(FILTER_SELECTORS.button, doc, textOf, null)
    expect(r.index).toBe(0)
    expect((r.el as Element).className).toBe('bR4uhU1W')
  })
})

describe('resolveSelector 可见性校验（防隐藏面板假命中）', () => {
  function dom() {
    const doc = {
      querySelector: (sel: string): unknown => document.querySelector(sel),
      querySelectorAll: (sel: string): unknown[] => Array.from(document.querySelectorAll(sel))
    }
    const textOf = (el: unknown): string => ((el as Element).textContent ?? '').trim()
    return { doc, textOf }
  }

  // mock 布局：隐藏元素返回 0 宽高（display:none/visibility:hidden 时真实 rect 即全 0），可见元素返回非零
  const rectOf = (hidden: Set<Element>) => (el: unknown): { width: number; height: number } => {
    const e = el as Element
    return hidden.has(e) ? { width: 0, height: 0 } : { width: 100, height: 40 }
  }

  it('css 候选命中隐藏元素时跳过，回退到可见的文字候选', () => {
    document.body.innerHTML = '<span class="bR4uhU1W" style="display:none">筛选</span><span>筛选</span>'
    const hidden = new Set<Element>([document.querySelector('.bR4uhU1W') as Element])
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null, rectOf(hidden))
    expect(r.index).toBe(1) // 候选1 命中但不可见 → 跳过，候选2 文字命中
    expect(r.el).not.toBeNull()
  })

  it('隐藏面板（display:none）contains 候选不命中，返回 el=null 且 index 记录被跳过的候选', () => {
    document.body.innerHTML =
      '<div id="panel" style="display:none"><span>排序依据</span><span>视频时长</span></div>'
    const hidden = new Set<Element>([document.getElementById('panel') as Element])
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null, rectOf(hidden))
    expect(r.el).toBeNull()
    expect(r.index).toBe(1) // contains 候选命中但不可见（供打点区分「完全未命中」与「隐藏假命中」）
  })

  it('全部候选命中但不可见 → el=null，index 为最后一个被跳过的候选', () => {
    document.body.innerHTML = '<span class="bR4uhU1W">筛选</span>'
    const hidden = new Set<Element>([document.querySelector('.bR4uhU1W') as Element])
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null, rectOf(hidden))
    expect(r.el).toBeNull()
    expect(r.index).toBe(1) // 文字候选命中同一个隐藏元素 → 也被跳过
  })

  it('可见面板正常命中（rect 宽高非零）', () => {
    document.body.innerHTML = '<div id="panel"><span>排序依据</span><span>视频时长</span></div>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.panel, doc, textOf, null, rectOf(new Set()))
    expect(r.index).toBe(1)
    expect((r.el as Element).id).toBe('panel')
  })

  it('不传 rectOf 时行为不变（兼容旧调用，无可见性过滤）', () => {
    document.body.innerHTML = '<span class="bR4uhU1W">筛选</span>'
    const { doc, textOf } = dom()
    const r = resolveSelector(FILTER_SELECTORS.button, doc, textOf, null)
    expect(r.index).toBe(0)
  })
})
