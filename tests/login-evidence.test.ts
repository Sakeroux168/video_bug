import { describe, it, expect, vi, afterEach } from 'vitest'

const cookies = vi.hoisted(() => ({ get: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {}, session: { fromPartition: vi.fn(() => ({ cookies })) } }))
import { VideoBrowser } from '../src/main/browser'
import { getAdapter } from '../src/main/adapters'

// 2026-10-06 全面检查「界面」D6：任务因为没登录暂停了，状态灯却还写「未知」，两边说法打架

afterEach(() => { cookies.get.mockReset(); cookies.get.mockResolvedValue([]) })

describe('D6 任务发现没登录 → 状态灯跟着变成「未登录」', () => {
  it('noteLoggedOut 之后查询状态是 logged_out；登录后（Cookie 变了）不再沿用', async () => {
    const b = new VideoBrowser({} as never)
    cookies.get.mockResolvedValue([{ name: 'ttwid', value: 'guest' }])
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'unknown' })
    await b.noteLoggedOut(getAdapter('kuaishou')!)
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'logged_out' })
    cookies.get.mockResolvedValue([{ name: 'ttwid', value: 'guest' }, { name: 'userId', value: 'u1' }])
    expect(await b.getLoginStatus(getAdapter('kuaishou')!)).toMatchObject({ status: 'unknown' })
  })
})
