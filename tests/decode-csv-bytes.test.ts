import { describe, it, expect } from 'vitest'
import { decodeCsvBytes } from '../src/renderer/src/components/authorsCsv'

// 用户实测：选了 .xlsx 直接当文本读，屏幕上全是压缩包字节，还产出 34 条「未识别」的假失败行。
// 根因：.xlsx 本质是 zip（PK 开头），而程序既没拦也没提示。
// 第二个必然会踩的坑：中文 Windows 的 Excel「另存为 CSV」默认存 GBK，按 UTF-8 读同样乱码。

const bytes = (...b: number[]): ArrayBuffer => new Uint8Array(b).buffer
const utf8 = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('decodeCsvBytes：识别不是 CSV 的文件', () => {
  it('.xlsx（zip，PK 开头）→ 明确告知要另存为 CSV，而不是当文本硬读', () => {
    const r = decodeCsvBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Excel')
    expect(r.error).toContain('CSV')
  })

  it('.xls（老版 Excel，OLE 复合文档）→ 同样拦下', () => {
    const r = decodeCsvBytes(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Excel')
  })
})

describe('decodeCsvBytes：编码', () => {
  it('UTF-8 正常解码', () => {
    const r = decodeCsvBytes(utf8('作者,链接\n张三,https://www.douyin.com/user/a'))
    expect(r.ok).toBe(true)
    expect(r.text).toContain('张三')
  })

  it('带 BOM 的 UTF-8（Excel 导出的标准形态）也能解', () => {
    const r = decodeCsvBytes(utf8('\uFEFF作者,链接\n张三,https://www.douyin.com/user/a'))
    expect(r.ok).toBe(true)
    expect(r.text).toContain('张三')
  })

  it('GBK 编码的 CSV（中文 Excel「另存为 CSV」默认编码）→ 自动按 GBK 重解，不是乱码', () => {
    // 「张三,https://x」的 GBK 字节：张=D5C5 三=C8FD，其余 ASCII 同 UTF-8
    const ascii = ',https://www.douyin.com/user/a'
    const tail = Array.from(ascii).map(c => c.charCodeAt(0))
    const r = decodeCsvBytes(bytes(0xd5, 0xc5, 0xc8, 0xfd, ...tail))
    expect(r.ok).toBe(true)
    expect(r.text).toContain('张三')
    expect(r.text).not.toContain('\uFFFD') // 不含替换字符 = 没按错编码解
  })

  it('纯 ASCII 内容两种编码解出来一样，不会误判', () => {
    const r = decodeCsvBytes(utf8('name,url\nzhangsan,https://www.douyin.com/user/a'))
    expect(r.ok).toBe(true)
    expect(r.text).toContain('zhangsan')
  })
})
