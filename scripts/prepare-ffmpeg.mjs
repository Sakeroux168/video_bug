// 打包前准备随包的 ffmpeg：electron-builder.yml 从 vendor/ffmpeg/bin/ 取 ffmpeg.exe 和 ffprobe.exe。
// 已经放好就什么都不做；没放但设了 FFMPEG_BIN_DIR（指向含这两个 exe 的 bin 目录）就复制过来；都没有就报错并说明怎么做。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = resolve('vendor/ffmpeg/bin')
const names = ['ffmpeg.exe', 'ffprobe.exe']
const missing = () => names.filter(n => !existsSync(join(target, n)))

if (missing().length > 0 && process.env.FFMPEG_BIN_DIR) {
  mkdirSync(target, { recursive: true })
  for (const n of missing()) {
    const from = join(process.env.FFMPEG_BIN_DIR, n)
    if (existsSync(from)) { copyFileSync(from, join(target, n)); console.log(`  已复制 ${from}`) }
  }
}

const left = missing()
if (left.length > 0) {
  console.error(`✗ 打包需要 ffmpeg，缺少：${left.map(n => join(target, n)).join('、')}`)
  console.error('  任选一种：')
  console.error('  1) 下载 Windows 版 ffmpeg（如 gyan.dev 的 essentials build），把 bin 里的 ffmpeg.exe、ffprobe.exe 放进 vendor/ffmpeg/bin/')
  console.error('  2) 设置环境变量 FFMPEG_BIN_DIR 指向含这两个 exe 的 bin 目录，再运行 npm run dist')
  process.exit(1)
}
console.log('  ✓ ffmpeg 已就绪：vendor/ffmpeg/bin/')
