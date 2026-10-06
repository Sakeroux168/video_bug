/**
 * 「翻到底了」提示的识别规则（2026-10-06 全面检查 B3）。
 *
 * 以前用 /没有更多|到底|暂时没有/ 扫整屏文字：卡片标题「这家店到底值不值」也会命中，
 * 小红书列表只收第一屏就收工、抖音作者按日期段抓会提前判「抓完」。
 * 现在整段文字必须**就是**一句到底提示（前后只允许空白和装饰符号），标题里夹着这几个字不算。
 *
 * 用字符串导出，好塞进页面脚本里（browser.ts 的 findBottomText）。
 */
const DECOR = String.raw`[\s\-—–~～·•.。…!！]*`
const ALL_GONE = String.raw`(?:暂时|已经)?没有更多(?:了|啦)?(?:的?(?:内容|作品|视频|笔记|结果|评论))?(?:了|啦)?`
const REACHED = String.raw`(?:已经|你已)?(?:到底|到底部|看到底)(?:了|啦)?`
export const BOTTOM_HINT_SOURCE = String.raw`^${DECOR}(?:${ALL_GONE}|${REACHED}|THE\s*END)${DECOR}$`
export const BOTTOM_HINT_FLAGS = 'i'

const re = new RegExp(BOTTOM_HINT_SOURCE, BOTTOM_HINT_FLAGS)
export function isBottomHint(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && re.test(t)
}
