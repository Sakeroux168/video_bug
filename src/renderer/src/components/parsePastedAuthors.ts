/**
 * 把「批量导入作者」文本框里粘贴的多行文本解析成待导入条目。
 *
 * 纯函数，渲染层不判断链接合法性、不解析 sec_uid——那些平台知识只在主进程 adapter 里有一份。
 * 这里只做「抓链接、剩下的当名称」：正则抓出行内第一个 https?://\S+，从行里摘掉，
 * 剩余 trim（含中间残留的 tab/逗号/多空格分隔符会被 trim 的头尾清理，
 * 但名称内部的逗号/空格原样保留，因此不能按空白 split）。
 *
 * 空行/纯空白行忽略；没有链接的行 url 为 ''，没有名称的行 nickname 为 ''，两种都照样产出条目，
 * 让主进程给出逐行 reason。
 */

// 不能用 \S+：逗号紧跟链接时会把分隔符和后面的名称一起吞进 URL，
// 结果名称与链接双双报废，用户只看到「未识别到抖音主页链接」，无从判断原因。
// 抖音 sec_uid 字符集是 [A-Za-z0-9_-]，不含这些分隔符，排除掉是安全的。
const URL_RE = /https?:\/\/[^\s,，、;；]+/

export function parsePastedAuthors(text: string): Array<{ nickname: string; url: string }> {
  const lines = text.split(/\r\n|\r|\n/)
  const result: Array<{ nickname: string; url: string }> = []

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue

    const match = URL_RE.exec(rawLine)
    if (!match) {
      result.push({ nickname: rawLine.trim(), url: '' })
      continue
    }

    const url = match[0]
    const rest = rawLine.slice(0, match.index) + rawLine.slice(match.index + url.length)
    // 去掉紧贴链接的单个分隔符（Tab/逗号），再 trim 两端多余空白；名称内部的逗号/空格保留
    // 先 trim 掉两端空白（含 Tab），再剥掉紧贴链接的分隔符，最后再 trim 一次。
    // 刻意不把 Tab 写进字符类：那需要在源码里放一个不可见字符，后人极易改坏。
    const nickname = rest.trim().replace(/^[,，、;；]+|[,，、;；]+$/g, '').trim()

    result.push({ nickname, url })
  }

  return result
}
