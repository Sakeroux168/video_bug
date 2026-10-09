import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

// 2026-10-07 用户改许可：MIT + Commons Clause（只禁止出售）→ PolyForm Noncommercial 1.0.0
// （非商业用途免费；任何商业用途都要向作者买商业授权）。仓库照样公开，只是不叫开源。
describe('项目许可契约', () => {
  it('许可证四件套存在，并明确源码可用、非商业免费、商用要买授权', () => {
    for (const file of ['LICENSE', 'LICENSE.zh-CN.md', 'NOTICE', 'TRADEMARKS.md']) {
      expect(existsSync(join(root, file)), `${file} 应存在`).toBe(true)
    }

    const license = read('LICENSE')
    expect(license).toContain('# PolyForm Noncommercial License 1.0.0')
    expect(license).toContain('Required Notice: Copyright 2026 Sakeroux168')
    expect(license).toContain('## Noncommercial Purposes')
    expect(license).toContain('Any noncommercial purpose is a permitted purpose.')
    expect(license).not.toContain('Commons Clause')
    expect(license).not.toContain('MIT License')

    const chinese = read('LICENSE.zh-CN.md')
    expect(chinese).toContain('源码可用')
    expect(chinese).toContain('不属于 OSI 定义的开源软件')
    expect(chinese).toContain('非商业用途免费')
    expect(chinese).toContain('商业授权')
    expect(chinese).toContain('英文 LICENSE')

    expect(read('NOTICE')).toContain('FFmpeg 8.0.1')
    expect(read('NOTICE')).toContain('https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d')
    expect(read('TRADEMARKS.md')).toContain('不授予商标权')
  })
})

describe('第三方许可证与发布门禁', () => {
  it('直接生产依赖全部声明为允许随包使用的 MIT 或 Apache-2.0', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { license?: string }> }
    const allowed = new Set(['MIT', 'Apache-2.0'])
    for (const name of Object.keys(pkg.dependencies)) {
      const license = lock.packages[`node_modules/${name}`]?.license
      expect(license, `${name} 必须声明许可证`).toBeTruthy()
      expect(allowed.has(license!), `${name}: ${license}`).toBe(true)
    }
  })

  it('随包法律材料包含 FFmpeg GPLv3 正文、精确构建来源及主要运行时许可', () => {
    const files = [
      'third_party/licenses/FFmpeg-GPLv3.txt',
      'third_party/licenses/FFmpeg-BUILD-INFO.txt',
      'third_party/licenses/Apache-2.0.txt',
      'third_party/licenses/Electron-MIT.txt',
      'third_party/licenses/React-MIT.txt'
    ]
    for (const file of files) expect(existsSync(join(root, file)), `${file} 应存在`).toBe(true)
    expect(read(files[0])).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(read(files[0])).toContain('Version 3, 29 June 2007')
    expect(read(files[1])).toContain('Version: 8.0.1-essentials_build-www.gyan.dev')
    expect(read(files[1])).toContain('License: GPL v3')
    expect(read(files[1])).toContain('https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d')
  })

  it('打包配置把法律材料放入 resources/licenses，verify 包含许可检查', () => {
    const builder = read('electron-builder.yml')
    expect(builder).toContain('from: third_party/licenses')
    expect(builder).toContain('to: licenses')

    const pkg = JSON.parse(read('package.json')) as { license?: string; scripts: Record<string, string> }
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE')
    expect(pkg.scripts['check:licenses']).toBe('node scripts/check-licenses.mjs')
    expect(pkg.scripts.verify).toContain('npm run check:licenses')
  })
})

