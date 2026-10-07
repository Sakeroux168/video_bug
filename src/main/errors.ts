import { ERROR } from '../shared/types'

export function classifyHttpError(status: number): string {
  if (status === 403 || status === 418) return ERROR.FORBIDDEN
  if (status >= 500 || status === 0) return ERROR.NETWORK
  return ''
}

/** 下载错误分类：http_ 前缀按状态码；非 http 错误按 Node 错误码（ENOENT/EPERM/ENOSPC → disk） */
export function classifyDownloadError(err: unknown): string {
  if (err instanceof Error && err.message.startsWith('http_')) {
    const status = Number(err.message.slice(5))
    return classifyHttpError(status) || ERROR.NETWORK
  }
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'EPERM' || code === 'ENOSPC') return ERROR.DISK
  if (err instanceof Error && err.message === 'bad_mp4') return ERROR.PARSE_ERROR
  if (err instanceof Error && err.message === 'bad_host') return ERROR.BAD_HOST
  return ERROR.NETWORK
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
