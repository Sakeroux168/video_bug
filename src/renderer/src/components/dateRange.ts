/**
 * R20：作者主页「只要这段时间发的」——日期段的校验与说明文字（爬主页面板和筛选表单共用一份，说法保持一致）。
 * 日期是 <input type="date"> 给的 YYYY-MM-DD；起止任一可以不填：
 * 只填「从」= 从那天到现在；只填「到」= 那天及以前。
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 合法返回 null，不合法返回一句给用户看的中文提示 */
export function checkDateRange(from: string, to: string): string | null {
  const f = from.trim()
  const t = to.trim()
  if (!f && !t) return '请至少选一个日期'
  if ((f && !DATE_RE.test(f)) || (t && !DATE_RE.test(t))) return '日期格式不对'
  if (f && t && f > t) return '开始日期不能晚于结束日期'
  return null
}

/** 把日期段说成人话，例如「只要 2026-09-01 到 2026-09-20 发的」 */
export function describeDateRange(from: string, to: string): string {
  const f = from.trim()
  const t = to.trim()
  if (f && t) return f === t ? `只要 ${f} 当天发的` : `只要 ${f} 到 ${t} 发的`
  if (f) return `只要 ${f} 以后发的`
  if (t) return `只要 ${t} 以前发的`
  return ''
}
