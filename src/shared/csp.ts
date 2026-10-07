/**
 * 主界面的内容安全策略（2026-10-07 安全加固 L5）：只在构建产物里加，开发态 Vite 要注入内联脚本（热更新），不加。
 * 界面不加载任何外部资源：脚本、样式只认本地；图片多一个 vs-cover:（素材库封面）和 data:。
 * 现在界面里没有 innerHTML 之类的写法，这是多一层保险。
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: vs-cover:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function injectCsp(html: string): string {
  return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`)
}
