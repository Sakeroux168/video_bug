import { describe, it, expect } from 'vitest'
import { checkDateRange, describeDateRange } from '../src/renderer/src/components/dateRange'
import { clampStuckTimeoutMin } from '../src/shared/types'

describe('日期段校验（爬主页面板 / 筛选表单共用）', () => {
  it('合法：两头都填、只填一头、同一天', () => {
    expect(checkDateRange('2026-09-01', '2026-09-20')).toBeNull()
    expect(checkDateRange('2026-09-01', '')).toBeNull()
    expect(checkDateRange('', '2026-09-20')).toBeNull()
    expect(checkDateRange('2024-02-29', '2024-02-29')).toBeNull()
  })
  it('一个都没填 / 开始晚于结束 / 日期不存在 → 给出中文提示', () => {
    expect(checkDateRange('', '')).toBe('请至少选一个日期')
    expect(checkDateRange('2026-09-20', '2026-09-01')).toBe('开始日期不能晚于结束日期')
    expect(checkDateRange('2026-02-31', '')).toBe('日期不对（这一天不存在）')
    expect(checkDateRange('', '2024-13-01')).toBe('日期不对（这一天不存在）')
    expect(checkDateRange('9.1', '')).toBe('日期不对（这一天不存在）')
  })
  it('说明文字', () => {
    expect(describeDateRange('2026-09-01', '2026-09-20')).toBe('只要 2026-09-01 到 2026-09-20 发的')
    expect(describeDateRange('2026-09-01', '2026-09-01')).toBe('只要 2026-09-01 当天发的')
    expect(describeDateRange('2026-09-01', '')).toBe('只要 2026-09-01 以后发的')
    expect(describeDateRange('', '2026-09-20')).toBe('只要 2026-09-20 以前发的')
  })
})

describe('卡住判定分钟数夹紧（R20 复查）', () => {
  it('空 / 非数字 / 0 / 负数 → 默认 5；1 → 2；超过 60 → 60；小数取整', () => {
    expect(clampStuckTimeoutMin('')).toBe(5)
    expect(clampStuckTimeoutMin(undefined)).toBe(5)
    expect(clampStuckTimeoutMin(Number.NaN)).toBe(5)
    expect(clampStuckTimeoutMin(0)).toBe(5)
    expect(clampStuckTimeoutMin(-3)).toBe(5)
    expect(clampStuckTimeoutMin(1)).toBe(2)
    expect(clampStuckTimeoutMin(100)).toBe(60)
    expect(clampStuckTimeoutMin(7.4)).toBe(7)
    expect(clampStuckTimeoutMin('10')).toBe(10)
  })
})
