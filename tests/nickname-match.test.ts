import { describe, it, expect } from 'vitest'
import { normalizeNickname, looseNicknameMatch } from '../src/main/nicknameMatch'

// 导入作者的「名称强绑定链接」校验用的匹配规则。
//
// 严格相等在真实场景下会大量误拒：抖音昵称普遍带 emoji、全角空格、装饰性标点，
// 而用户是手打或从别处拷来的，几乎不可能一字不差。所以规范化后再做互相包含判断。

describe('normalizeNickname', () => {
  it('去掉各种空白（含全角空格）', () => {
    expect(normalizeNickname('张 三')).toBe('张三')
    expect(normalizeNickname('张\u3000三')).toBe('张三')
    expect(normalizeNickname('  张三\t')).toBe('张三')
  })

  it('去掉 emoji 与装饰性标点', () => {
    expect(normalizeNickname('张三🌟')).toBe('张三')
    expect(normalizeNickname('✨张三✨')).toBe('张三')
    expect(normalizeNickname('张三-日常')).toBe('张三日常')
    expect(normalizeNickname('【张三】')).toBe('张三')
  })

  it('英文统一小写', () => {
    expect(normalizeNickname('JohnDoe')).toBe('johndoe')
  })

  it('全部被过滤时返回空串（调用方据此判定无法比对）', () => {
    expect(normalizeNickname('🌟✨')).toBe('')
    expect(normalizeNickname('   ')).toBe('')
  })
})

describe('looseNicknameMatch', () => {
  it('完全相同 → 匹配', () => {
    expect(looseNicknameMatch('张三', '张三')).toBe(true)
  })

  it('真实昵称比用户填的多带后缀/emoji → 仍匹配', () => {
    expect(looseNicknameMatch('张三', '张三 🌟日常')).toBe(true)
    expect(looseNicknameMatch('张三', '✨张三✨')).toBe(true)
  })

  it('用户填得比真实昵称更长但包含它 → 仍匹配', () => {
    expect(looseNicknameMatch('张三的日常', '张三')).toBe(true)
  })

  it('完全不同的人 → 不匹配', () => {
    expect(looseNicknameMatch('张三', '李四')).toBe(false)
  })

  it('只是碰巧共用一个字 → 不匹配（互相包含，不是有交集）', () => {
    expect(looseNicknameMatch('张三', '三体')).toBe(false)
  })

  it('任意一侧规范化后为空 → 不匹配（宁可拒绝也不放行）', () => {
    expect(looseNicknameMatch('🌟', '张三')).toBe(false)
    expect(looseNicknameMatch('张三', '   ')).toBe(false)
    expect(looseNicknameMatch('', '')).toBe(false)
  })

  it('英文大小写差异不影响', () => {
    expect(looseNicknameMatch('johndoe', 'JohnDoe Official')).toBe(true)
  })
})
