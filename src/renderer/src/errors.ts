/**
 * 错误码 → 中文原因（T4 失败可视化）。
 * 码值来自主进程分类（shared/types.ts 的 ERROR 常量 + downloader 存储的 error 列），
 * 未知/未分类码返回原文，空码返回「未知错误」。
 */
export function describeError(code: string | null | undefined): string {
  if (!code) return '未知错误'
  switch (code) {
    case 'network': return '网络错误（已自动重试2次）'
    case 'page_timeout': return '页面 30 秒没打开（网络不通、代理挂了，或被平台拦下了）'
    case 'address_expired': return '下载链接已过期'
    case 'forbidden': return '平台拒绝（可能风控）'
    case 'login_expired': return '登录已过期'
    case 'disk': return '磁盘错误（目录不可写或空间不足）'
    case 'parse_error': return '文件解析失败'
    case 'ai_auth': return 'AI认证失败'
    case 'ai_quota': return 'AI额度用尽'
    case 'ai_timeout': return 'AI超时'
    case 'bad_mp4': return '文件校验失败（非视频）'
    default: return code
  }
}
