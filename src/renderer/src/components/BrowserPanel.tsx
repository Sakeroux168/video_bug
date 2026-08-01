import React from 'react'
import { api } from '../api'

export default function BrowserPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <p className="text-lg">内置浏览器已在此标签下方显示</p>
      <p className="text-sm">首次使用请在这里扫码登录抖音，登录态会自动保存</p>
      <p className="text-xs">触发风控验证时，也在这里手动完成</p>
      <button
        type="button"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
        onClick={() => void api.openBrowserDevtools()}
      >
        打开调试控制台
      </button>
    </div>
  )
}
