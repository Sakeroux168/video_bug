/** 页面阻塞信号共用一张表；只检查地址、标题、可见 iframe 和可见文字，不读跨域 DOM。 */
export const VERIFY_TEXT_PATTERN = /验证码|滑动验证|安全验证|拖动滑块|请完成验证|机器人验证|完成拼图|点击完成|安全校验|verify|captcha/i
export const LOGIN_TEXT_PATTERN = /登录即可查看\s*Ta\s*的笔记|登录后查看搜索结果|登录后即可搜索更多精彩视频|登录即可享受|扫码登录|手机号登录|验证码登录|密码登录|获取验证码|发送验证码/i

interface Signals { url: RegExp; title: RegExp; text: RegExp }
interface PlatformSignals {
  verify: Signals
  login: Signals
  /** 仅收已在测试档案核实的认证 Cookie，不把游客 Cookie 当成登录凭据。 */
  loginCookies: readonly string[]
  loggedOutText: RegExp
}
const never = /$a/
const verify: Signals = {
  // 不匹配后台常驻的 rmc-nocaptcha / rc-verifycenter 静态资源。
  url: /^https?:\/\/(?:rmc\.bytedance\.com\/verifycenter\/captcha|(?:www\.)?(?:douyin\.com|kuaishou\.com|xiaohongshu\.com)\/(?:captcha|verify|verification))(?:[/?#]|$)/i,
  title: /验证码中间页|安全验证|滑动验证|机器人验证|请完成验证|^captcha(?: verification)?$/i,
  text: VERIFY_TEXT_PATTERN
}
export const PAGE_SIGNALS: Record<string, PlatformSignals> = {
  douyin: {
    verify, login: { url: /^https?:\/\/(?:www\.)?douyin\.com\/(?:login|passport)(?:[/?#]|$)/i,
      title: /^抖音登录|^登录抖音/, text: /登录后即可搜索更多精彩视频|扫码登录|验证码登录|密码登录/i },
    loginCookies: ['sessionid', 'sessionid_ss'], loggedOutText: /^登录$/
  },
  kuaishou: {
    verify, login: { url: /^https?:\/\/(?:www\.)?kuaishou\.com\/(?:login|passport)(?:[/?#]|$)/i,
      title: /^快手登录|^登录快手/, text: /登录即可享受|扫码登录|验证码登录|密码登录/i },
    loginCookies: [], loggedOutText: /登录即可享受/
  },
  xiaohongshu: {
    verify, login: { url: /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:login|passport)(?:[/?#]|$)/i,
      title: /^小红书登录|^登录小红书/, text: /登录即可查看\s*Ta\s*的笔记|登录后查看搜索结果|手机号登录/i },
    loginCookies: ['web_session'], loggedOutText: /登录后查看搜索结果|手机号登录/
  }
}

export function urlIndicator(platform: string, kind: 'verify' | 'login', url: string): string | null {
  const config = PAGE_SIGNALS[platform]
  return config?.[kind].url.test(url) ? (kind === 'verify' ? '验证页面（地址命中）' : '登录页面（地址命中）') : null
}

// 可见性共用，既检查 CSS（尺寸无法排除 visibility:hidden），也检查祖先和视口。
const visibility = `const inView = el => {
  for (let p = el; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0') return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right !== 0;
};`

export function buildBlockScript(platform: string, kind: 'verify' | 'login', textOverride?: RegExp): string {
  const signals = PAGE_SIGNALS[platform]?.[kind] ?? { url: never, title: never, text: never }
  return `(() => {
    const urlRe = ${signals.url}; const titleRe = ${signals.title}; const re = ${textOverride ?? signals.text};
    const loginRe = ${LOGIN_TEXT_PATTERN};
    const stripLogin = t => t.replace(new RegExp(loginRe.source, 'gi'), '');
    ${visibility}
    if (urlRe.test(location.href)) return '${kind === 'verify' ? '验证' : '登录'}页面（地址命中）';
    if (titleRe.test(document.title)) return document.title.slice(0, 40);
    for (const el of document.querySelectorAll('iframe')) {
      if (inView(el) && urlRe.test(el.src)) return '${kind === 'verify' ? '验证' : '登录'}内嵌框';
    }
    if (${kind === 'verify'}) {
      for (const el of document.querySelectorAll('[class*="captcha" i], [class*="verify" i], [id*="captcha" i], [class*="modal-mask"], [class*="dialog"]')) {
        if (!inView(el)) continue;
        const t = (el.textContent || '').trim();
        if (t && re.test(stripLogin(t))) return t.slice(0, 40);
        if (t && loginRe.test(t)) continue;
        // 普通空对话框不代表验证；明确 captcha/verify 结构保留兜底。
        if (/captcha|verify/i.test(el.className + ' ' + el.id)) return '验证弹窗（结构命中）';
      }
    }
    if (!document.body) return null;
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
    // 性能检查 F6：先匹配文字，命中了才判断看不看得见（inView 每次都要往上逐层 getComputedStyle，满屏卡片时很贵）
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: node => {
      const el = node.parentElement;
      return el && !skip.has(el.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }});
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = (node.textContent || '').trim();
      if (t && re.test(${kind === 'verify' ? 'stripLogin(t)' : 't'}) && inView(node.parentElement)) return t.slice(0, 40);
    }
    return null;
  })()`
}

/** 只把看得见的同一 iframe 对应到主进程读到的 URL，隐藏 iframe 不阻塞任务。 */
export function buildFrameVisibilityScript(url: string): string {
  return `(() => { ${visibility} return [...document.querySelectorAll('iframe')].some(el => el.src === ${JSON.stringify(url)} && inView(el)); })()`
}

export function buildLoginStatusScript(platform: string): string {
  const re = PAGE_SIGNALS[platform]?.loggedOutText ?? never
  return `(() => {
    ${visibility}
    if (${JSON.stringify(platform)} === 'xiaohongshu') {
      const v = window.__INITIAL_STATE__?.user?.loggedIn;
      const value = v && typeof v === 'object' ? (v.value ?? v._value) : v;
      if (value === true) return 'logged_in';
      if (value === false) return 'logged_out';
    }
    const re = ${re};
    for (const el of document.querySelectorAll('button, a, [role="button"], span, p')) {
      if (re.test((el.textContent || '').trim()) && inView(el)) return 'logged_out'; // 先比文字再算可见性（F6）
    }
    return 'unknown';
  })()`
}
