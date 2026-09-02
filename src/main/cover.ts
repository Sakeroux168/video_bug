import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function coverExtension(contentType: string | null): '.jpg' | '.png' | '.webp' {
  const normalized = contentType?.split(';', 1)[0].trim().toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/webp') return '.webp'
  return '.jpg'
}

export interface DownloadCoverInput {
  url: string
  dir: string
  stem: string
  fetchImpl: typeof fetch
  signal: AbortSignal
  headers: Record<string, string>
}

/** 封面是附属资源：普通失败返回 null；中止必须抛出，由下载器统一处理暂停/取消。 */
export async function downloadCover(input: DownloadCoverInput): Promise<string | null> {
  const part = join(input.dir, `${input.stem}.cover.part`)
  try {
    const response = await input.fetchImpl(input.url, {
      signal: input.signal,
      headers: input.headers
    })
    if (!response.ok || !response.body) return null
    const ext = coverExtension(response.headers.get('content-type'))
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream, { signal: input.signal }),
      createWriteStream(part)
    )
    const finalPath = join(input.dir, `${input.stem}${ext}`)
    await rename(part, finalPath)
    return finalPath
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined)
    if (input.signal.aborted) throw error
    return null
  }
}
