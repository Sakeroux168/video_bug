/**
 * R20：抓取任务排队（串行，一次只跑一个）。原来写在 index.ts 里，抽出来是为了能单独测。
 *
 * 以前只有「任务完成（task:done）」才放行下一个；任务因为任何原因暂停、失败、出错，
 * 或者干脆卡死不动，后面排队的就永远停在「等待中」——用户看到的就是
 * 「有个人一直卡着说运行中，动也不动，其他的都排着队」。
 *
 * 现在的规则：
 * - 当前任务**只要结束了**（完成 / 暂停 / 失败 / 出错 / 被看门狗判卡住）就放行下一个。
 * - 唯一例外：弹了验证码（stalled_verify）。这时要等人在浏览器里过验证，
 *   接着跑下一个会把验证页面冲掉、而且下一个多半也会被拦——所以先按住不放，
 *   等有任务重新跑起来（用户点「继续」）或用户手动建/删任务时再说。
 * - 暂停的任务不会自己重新排队（不会循环重试），要用户点「继续」。
 */
export interface TaskQueueDeps {
  /** 调度器是否正有任务在跑 */
  isRunning: () => boolean
  /** 开跑某个任务（调度器 run）；promise 在 run 退出时 resolve（卡死时可能永远不 resolve，靠事件放行） */
  run: (id: number) => Promise<void>
  /** 出错时打日志 */
  log?: (msg: string) => void
  /** 延迟执行（默认 setImmediate）：任务发终态事件时调度器 running 还没复位，要等当前调用栈走完 */
  defer?: (fn: () => void) => void
}

export class TaskQueue {
  private pending: number[] = []
  private queued = new Set<number>()
  /** 验证码暂停后按住队列，不自动放行 */
  private held = false

  constructor(private deps: TaskQueueDeps) {}

  /** 排队中的任务 id（按顺序） */
  get ids(): number[] { return [...this.pending] }
  /** 是否因验证码暂停而按住了自动放行 */
  get isHeld(): boolean { return this.held }

  /** 新任务入队（去重）。这是用户/外部程序的主动操作，不受「按住」影响。 */
  enqueue(id: number): void {
    if (this.queued.has(id)) return
    this.queued.add(id)
    this.pending.push(id)
    this.next(false)
  }

  /** 从队列里摘掉（删任务 / 用户直接「开始」某个排队任务时用） */
  remove(id: number): void {
    this.queued.delete(id)
    const i = this.pending.indexOf(id)
    if (i >= 0) this.pending.splice(i, 1)
  }

  /** 手动踢一脚（删任务等用户操作之后）：不受「按住」影响 */
  kick(): void { this.next(false) }

  /** 调度器事件：据此判断当前任务是否结束、要不要放行下一个 */
  onEvent(evt: unknown): void {
    const t = evt as { type?: string; status?: string; reason?: string } | null
    if (!t) return
    if (t.type === 'task:progress' && t.status === 'running') { this.held = false; return }
    if (t.type === 'task:done') { this.next(true); return }
    if (t.type === 'task:paused') {
      if (t.reason === 'stalled_verify') { this.held = true; return }
      this.next(true)
    }
  }

  /** 放行下一个。auto=true 是「上一个结束了自动接着跑」，验证码按住时不放；auto=false 是用户主动操作。 */
  private next(auto: boolean): void {
    const defer = this.deps.defer ?? ((fn: () => void) => { setImmediate(fn) })
    defer(() => {
      if (auto && this.held) return
      if (this.deps.isRunning()) return
      const id = this.pending.shift()
      if (id === undefined) return
      this.queued.delete(id)
      let p: Promise<void>
      try {
        p = Promise.resolve(this.deps.run(id))
      } catch (err) {
        p = Promise.reject(err)
      }
      // run 退出（任何结局，包括取任务行出错、平台不存在这类不发事件的早退）→ 接着放行。
      // 卡死的 run 永远不退出，那种情况由看门狗发 task:paused(stuck) 放行。
      p.then(() => this.next(true), (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        this.deps.log?.(`启动任务 ${id} 时异常：${detail}`)
        this.next(true)
      })
    })
  }
}
