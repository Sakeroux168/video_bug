/**
 * R20：抓取任务排队（串行，一次只跑一个）。原来写在 index.ts 里，抽出来是为了能单独测。
 *
 * 以前只有「任务完成（task:done）」才放行下一个；任务因为任何原因暂停、失败、出错，
 * 或者干脆卡死不动，后面排队的就永远停在「等待中」——用户看到的就是
 * 「有个人一直卡着说运行中，动也不动，其他的都排着队」。
 *
 * 现在的规则（R20 复查后）：
 * - 任务**结束了**就放行下一个：完成 / 失败 / 调度出错 / 被看门狗判卡住（stuck）/ 重搜用尽（stalled）/ 作者校验不过，
 *   以及 run 不发事件就退出的早退。
 * - **按住不放**的三种：弹验证码（stalled_verify，要等人过验证，接着跑会把验证页冲掉、下一个多半也被拦）、
 *   疑似风控（risk，连着跑只会继续撞风控）、用户自己点了暂停（user，用户就是想停）。
 *   按住期间新进来的任务（包括发布助手经本机接口建的）也只排队不开跑；
 *   用户点某个任务的「开始」/「继续」让它跑起来、或删任务时才松开。
 * - 暂停的任务不会自己重新排队（不会循环重试），要用户点「继续」。
 */
/** 这些暂停原因会按住队列 */
const HOLD_REASONS = new Set(['stalled_verify', 'risk', 'user'])

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

  /** 新任务入队（去重）。R20 复查：按住期间只排队不开跑——发布助手趁用户过验证码时建任务，
   *  以前会直接开跑、把验证页面冲掉。 */
  enqueue(id: number): void {
    if (this.queued.has(id)) return
    this.queued.add(id)
    this.pending.push(id)
    this.next(true)
  }

  /** 从队列里摘掉（删任务 / 用户直接「开始」某个排队任务时用） */
  remove(id: number): void {
    this.queued.delete(id)
    const i = this.pending.indexOf(id)
    if (i >= 0) this.pending.splice(i, 1)
  }

  /** 用户明确操作之后（删任务）踢一脚：松开按住，接着跑下一个 */
  kick(): void {
    this.held = false
    this.next(false)
  }

  /** 调度器事件：据此判断当前任务是否结束、要不要放行下一个 */
  onEvent(evt: unknown): void {
    const t = evt as { type?: string; status?: string; reason?: string } | null
    if (!t) return
    if (t.type === 'task:progress' && t.status === 'running') { this.held = false; return }
    if (t.type === 'task:done') { this.next(true); return }
    if (t.type === 'task:paused') {
      if (t.reason && HOLD_REASONS.has(t.reason)) { this.held = true; return }
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
