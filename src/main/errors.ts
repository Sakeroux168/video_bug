import { ERROR } from '../shared/types'

export function classifyHttpError(status: number): string {
  if (status === 403 || status === 418) return ERROR.FORBIDDEN
  if (status >= 500 || status === 0) return ERROR.NETWORK
  return ''
}

export function isRiskSignal(count: number): boolean {
  return count >= 3
}

export class AddressPolicy {
  constructor(private ttlMin: number) {}
  isExpired(fetchedAt: string): boolean {
    const fetched = new Date(fetchedAt).getTime()
    return Date.now() - fetched > this.ttlMin * 60 * 1000
  }
}
