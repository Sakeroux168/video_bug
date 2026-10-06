/** 退出前收尾：拆成纯函数便于测试（index.ts 依赖 electron，测不了） */
export interface QuitParts {
  processor: { stop(): void } | null
  browser: { dispose(): void } | null
  bridge: { close(): void } | null
}

export function onBeforeQuit(parts: QuitParts): void {
  // 视频处理正在转码时不停，Windows 上 ffmpeg 子进程不会跟着退出，会继续满负荷跑完
  try { parts.processor?.stop() } catch { /* ignore */ }
  // 销毁浏览器子窗口：否则 close→hide 拦截让 quit 被 preventDefault 中止、window-all-closed 也因隐藏子窗口永不触发
  parts.browser?.dispose()
  parts.bridge?.close()
}
