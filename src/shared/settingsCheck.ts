/**
 * 设置保存前的校验（2026-10-07 安全加固 L6），界面和主进程共用。合法返回 null，否则返回一句说明。
 * - 下载目录不能是盘根、系统文件夹、用户文件夹本身：「文件管理」能删下载目录里的任何东西，设成 C:\\ 就等于能删整个盘
 * - AI 接口地址要用 https（本机的 localhost / 127.0.0.1 除外）：http 会把 Key 明文发出去
 */
export function checkSettings(s: { downloadDir?: string; aiBaseUrl?: string }): string | null {
  const dir = String(s.downloadDir ?? '').trim().replace(/\//g, '\\')
  if (dir) {
    if (/^[A-Za-z]:\\?$/.test(dir)) return '下载目录不能是整个磁盘（比如 D:\\），请选一个文件夹'
    if (/^[A-Za-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i.test(dir)) return '下载目录不能放在系统文件夹里'
    if (/^[A-Za-z]:\\users\\[^\\]+\\?$/i.test(dir)) return '下载目录不能是用户文件夹本身，请在里面选一个子文件夹'
  }
  const ai = String(s.aiBaseUrl ?? '').trim()
  if (ai) {
    let u: URL | null = null
    try { u = new URL(ai) } catch { u = null }
    const local = !!u && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (!u || (u.protocol !== 'https:' && !local)) return 'AI 接口地址要用 https://（本机的 localhost 除外），不然 Key 会明文发出去'
  }
  return null
}
