// src/main/nicknameMatch.ts — 作者昵称的宽松匹配（导入作者的「名称强绑定链接」校验用）
//
// 为什么不用严格相等：抖音昵称普遍带 emoji、全角空格、装饰性标点（「✨张三✨」「张三 🌟日常」），
// 而用户填的是手打或从表格拷来的。严格相等在真实场景下会把绝大多数正确的导入也拒掉，
// 校验就从「防错」变成了「添堵」。
//
// 规则：两侧各自规范化（去空白/emoji/标点、英文转小写）后，**互相包含**即算匹配。
// 用互相包含而不是「有交集」——「张三」和「三体」共用一个字但显然不是一个人。

/** 规范化：去掉所有空白（含全角）、emoji 与装饰性标点，英文转小写 */
export function normalizeNickname(s: string): string {
  return s
    .normalize('NFKC')
    // 空白：半角/全角/制表符等
    .replace(/[\s\u3000]+/g, '')
    // 保留中日韩文字、字母、数字；其余（emoji、标点、括号、连字符…）一律去掉。
    // 用「保留白名单」而非「排除黑名单」：emoji 码位分散在多个平面，黑名单必然漏。
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/**
 * 宽松匹配：规范化后互相包含即算同一人。
 * 任意一侧规范化后为空（例如纯 emoji 昵称）→ 判定不匹配——无法比对时宁可拒绝也不放行。
 */
export function looseNicknameMatch(a: string, b: string): boolean {
  const x = normalizeNickname(a)
  const y = normalizeNickname(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}
