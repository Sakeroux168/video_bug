import { describe, it, expect } from 'vitest'
import { classifyHttpError, isRiskSignal, AddressPolicy } from '../src/main/errors'
import { ERROR } from '../src/shared/types'

describe('classifyHttpError', () => {
  it('403 → forbidden', () => expect(classifyHttpError(403)).toBe(ERROR.FORBIDDEN))
  it('5xx → network', () => expect(classifyHttpError(500)).toBe(ERROR.NETWORK))
  it('200 → 空串', () => expect(classifyHttpError(200)).toBe(''))
})

describe('isRiskSignal', () => {
  it('连续3次 → true', () => expect(isRiskSignal(3)).toBe(true))
  it('少于3次 → false', () => expect(isRiskSignal(2)).toBe(false))
})

describe('AddressPolicy', () => {
  it('超过 TTL 过期', () => {
    const p = new AddressPolicy(30)
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    expect(p.isExpired(old)).toBe(true)
    expect(p.isExpired(fresh)).toBe(false)
  })
})
