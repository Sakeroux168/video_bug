import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(join(root, file), 'utf8')
const errors = []
const requireFile = (file, phrases = []) => {
  const full = join(root, file)
  if (!existsSync(full)) {
    errors.push(`缺少 ${file}`)
    return
  }
  const contents = read(file)
  for (const phrase of phrases) if (!contents.includes(phrase)) errors.push(`${file} 缺少关键内容: ${phrase}`)
}

requireFile('LICENSE', ['Commons Clause', 'right to Sell the Software', 'MIT License', 'Licensor: Sakeroux168'])
requireFile('LICENSE.zh-CN.md', ['源码可用', '禁止出售软件本身', '允许利用软件输出赚钱'])
requireFile('NOTICE', ['FFmpeg 8.0.1', '894da5ca7d', 'Electron 35.7.5', 'sherpa-onnx-node'])
requireFile('TRADEMARKS.md', ['不授予商标权'])
requireFile('third_party/licenses/FFmpeg-GPLv3.txt', ['GNU GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007'])
requireFile('third_party/licenses/FFmpeg-BUILD-INFO.txt', ['License: GPL v3', '894da5ca7d'])
requireFile('third_party/licenses/Apache-2.0.txt', ['Apache License', 'Version 2.0'])
requireFile('third_party/licenses/Electron-MIT.txt', ['Copyright (c) Electron contributors', 'Permission is hereby granted'])
requireFile('third_party/licenses/React-MIT.txt', ['MIT License', 'Permission is hereby granted'])

const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
if (pkg.license !== 'SEE LICENSE IN LICENSE') errors.push('package.json license 必须指向 LICENSE')
const allowedRuntimeLicenses = new Set(['MIT', 'Apache-2.0'])
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const license = lock.packages?.[`node_modules/${name}`]?.license
  if (!license) errors.push(`运行时依赖 ${name} 未声明许可证`)
  else if (!allowedRuntimeLicenses.has(license)) errors.push(`运行时依赖 ${name} 的许可证未获允许: ${license}`)
}

const builder = read('electron-builder.yml')
if (!builder.includes('from: third_party/licenses') || !builder.includes('to: licenses')) {
  errors.push('electron-builder.yml 未把 third_party/licenses 打入 resources/licenses')
}

if (process.argv.includes('--packaged')) {
  const packagedDir = join(root, 'dist', 'win-unpacked', 'resources', 'licenses')
  const packagedFiles = [
    'PROJECT-LICENSE.txt', 'PROJECT-LICENSE.zh-CN.md', 'NOTICE.txt', 'TRADEMARKS.md',
    'FFmpeg-GPLv3.txt', 'FFmpeg-BUILD-INFO.txt', 'Apache-2.0.txt', 'Electron-MIT.txt', 'React-MIT.txt'
  ]
  for (const file of packagedFiles) {
    if (!existsSync(join(packagedDir, file))) errors.push(`打包产物缺少 resources/licenses/${file}`)
  }
}

if (errors.length) {
  for (const error of errors) console.error(`  ✗ ${error}`)
  process.exit(1)
}

console.log(`  ✓ 许可检查通过${process.argv.includes('--packaged') ? '（含打包产物）' : ''}`)
