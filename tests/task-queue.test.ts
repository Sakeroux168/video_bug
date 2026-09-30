import { describe, it, expect, vi } from 'vitest'
import { TaskQueue } from '../src/main/taskQueue'

// R20：用户反馈「有个人一直卡着说运行中，动也不动，其他的都排着队」。
// 以前只有任务「完成」才放行下一个；暂停、失败、出错、卡死都会让后面的永远等着。

/** 假调度器：run 返回一个可手动结束的 promise；running 由测试控制（模拟调度器 isRunning） */
function fakeScheduler() {
  const started: number[] = []
  const finish = new Map<number, () => void>()
  const state = { running: false }
  const run = vi.fn((id: number) => {
    started.push(id)
    state.running = true
    return new Promise<void>(resolve => {
      finish.set(id, () => { state.running = false; resolve() })
    })
  })
  return { started, finish, state, run }
}

const flush = (): Promise<void> => new Promise(r => setImmediate(r))
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await flush() }

function setup() {
  const s = fakeScheduler()
  const logs: string[] = []
  const q = new TaskQueue({ isRunning: () => s.state.running, run: s.run, log: m => logs.push(m) })
  return { q, s, logs }
}

describe('任务队列：任务怎么结束都放行下一个（R20）', () => {
  it('一次只跑一个；第一个没结束时后面的排着', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2); q.enqueue(3)
    await settle()
    expect(s.started).toEqual([1])
    expect(q.ids).toEqual([2, 3])
  })

  it('完成（task:done）→ 下一个接着跑', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.state.running = false
    q.onEvent({ type: 'task:done', taskId: 1, fetched: 3 })
    await settle()
    expect(s.started).toEqual([1, 2])
  })

  it.each([
    ['用户暂停', '用户暂停或风控'],
    ['停滞重搜用尽', 'stalled'],
    ['调度出错 / 失败', 'scheduler_error'],
    ['看门狗判卡住', 'stuck'],
    ['作者校验失败', 'author_mismatch']
  ])('%s（task:paused reason=%s）→ 下一个接着跑，不再永远等着', async (_name, reason) => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.state.running = false // 调度器已收尾（看门狗强制停时 run 的 promise 可能永远不结束，只有事件）
    q.onEvent({ type: 'task:paused', taskId: 1, reason })
    await settle()
    expect(s.started).toEqual([1, 2])
  })

  it('run 静默退出（不发任何事件的早退，如任务行已被删）→ 也放行下一个', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.finish.get(1)!()
    await settle()
    expect(s.started).toEqual([1, 2])
  })

  it('run 抛异常 → 记日志并放行下一个', async () => {
    const logs: string[] = []
    const started: number[] = []
    const q = new TaskQueue({
      isRunning: () => false,
      run: async id => { started.push(id); if (id === 1) throw new Error('取任务行失败') },
      log: m => logs.push(m)
    })
    q.enqueue(1); q.enqueue(2)
    await settle()
    expect(started).toEqual([1, 2])
    expect(logs.some(l => l.includes('取任务行失败'))).toBe(true)
  })

  it('暂停的任务不会被自动重新排队（不会循环重试）', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.state.running = false
    q.onEvent({ type: 'task:paused', taskId: 1, reason: 'stuck' })
    await settle()
    s.finish.get(2)!()
    q.onEvent({ type: 'task:done', taskId: 2, fetched: 1 })
    await settle()
    expect(s.started).toEqual([1, 2]) // 1 没有再被跑
    expect(q.ids).toEqual([])
  })

  it('弹验证码（stalled_verify）→ 按住不放（等人过验证），直到有任务重新跑起来', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.state.running = false
    q.onEvent({ type: 'task:paused', taskId: 1, reason: 'stalled_verify' })
    s.finish.get(1)!() // run 也退出了
    await settle()
    expect(s.started).toEqual([1])
    expect(q.isHeld).toBe(true)

    // 用户过完验证点「继续」→ 任务 1 重新跑起来（调度器发 running 进度）→ 解除按住；它结束后放行 2
    s.state.running = true
    q.onEvent({ type: 'task:progress', taskId: 1, fetched: 0, status: 'running' })
    expect(q.isHeld).toBe(false)
    s.state.running = false
    q.onEvent({ type: 'task:done', taskId: 1, fetched: 5 })
    await settle()
    expect(s.started).toEqual([1, 2])
  })

  it('验证码按住期间，用户手动操作（新建任务 / 删任务踢一脚）照样放行', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2)
    await settle()
    s.state.running = false
    q.onEvent({ type: 'task:paused', taskId: 1, reason: 'stalled_verify' })
    await settle()
    expect(s.started).toEqual([1])
    q.kick()
    await settle()
    expect(s.started).toEqual([1, 2])
  })

  it('remove：还在排队的任务被摘掉，轮不到它', async () => {
    const { q, s } = setup()
    q.enqueue(1); q.enqueue(2); q.enqueue(3)
    await settle()
    q.remove(2)
    s.state.running = false
    q.onEvent({ type: 'task:done', taskId: 1, fetched: 0 })
    await settle()
    expect(s.started).toEqual([1, 3])
  })

  it('重复入队去重', async () => {
    const { q } = setup()
    q.enqueue(1); q.enqueue(2); q.enqueue(2)
    await settle()
    expect(q.ids).toEqual([2])
  })
})
