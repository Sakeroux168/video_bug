import { existsSync } from 'fs'
import { join } from 'path'

export function safeFilename(title: string, author: string, awemeId: string): string {
  const base = `${title ? title + '_' : ''}${author}_${awemeId.slice(0, 8)}`
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const trimmed = base.length > 80 ? base.slice(0, 80) : base
  return trimmed || `${author}_${awemeId}`
}

export function ensureUniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  while (existsSync(join(dir, `${stem}_${i}${ext}`))) i++
  return `${stem}_${i}${ext}`
}
