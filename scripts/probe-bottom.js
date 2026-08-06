// 探针：实机探测「抖音搜索页滑到底后，DOM 检测能否命中『暂时没有更多了』提示」（round13 Task 1）
// 运行：npx electron scripts/probe-bottom.js [关键词]   （默认「农村搞笑」）
//   - 复用 persist:douyin 登录态（与 src/main/browser.ts VideoBrowser 同款 partition）
//   - 滚动循环：最多 12 轮，每轮滚到底（scrollToBottom 简化版）+ 等 2.5s，连续 2 轮高度无增长 → 到底
//   - 检测：与 findBottomText 同款脚本（正则 /没有更多|到底|暂时没有/i + inView 校验）
//   - 诊断：底部可见文本片段 / innerText 尾部 / scrollHeight·innerHeight·scrollTop 快照
// CJS、零构建产物。全部输出到 stdout 后 3s 自动退出。
'use strict'
const { app, BrowserWindow } = require('electron')
const { join } = require('path')

// 关键：bare electron 默认 userData = %APPDATA%\Electron，与真实应用（%APPDATA%\video-scraper）不同，
// 会导致 persist:douyin 分区读不到真实应用的登录态。这里在 ready 前把 userData 指到真实应用目录。
app.setName('video-scraper')
app.setPath('userData', join(app.getPath('appData'), 'video-scraper'))

const KEYWORD = process.argv[2] || '农村搞笑'
const URL = `https://www.douyin.com/search/${encodeURIComponent(KEYWORD)}?type=general`

const MAX_ROUNDS = 12
const ROUND_WAIT_MS = 2500
const STALL_LIMIT = 2 // 连续 N 轮高度无增长 → 判定到底
const LOAD_TIMEOUT_MS = 30000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── findBottomText 同款检测脚本（原样复制 src/main/browser.ts findBottomText 的注入脚本） ──
const DETECT_SCRIPT = `(() => {
  const re = /没有更多|到底|暂时没有/i;
  // 可见 + 视口内：宽高 > 0（排除 display:none/visibility:hidden）且与视口相交（排除滚到底前就存在的隐藏提示）
  const inView = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  };
  // 快速路径：真实元素 css 候选（抖音实测 div.nU717OFZ），同样校验可见性 + 视口
  try {
    const real = document.querySelector('div.nU717OFZ');
    if (real && inView(real)) {
      const t = (real.textContent || '').trim();
      if (t && re.test(t)) return t.slice(0, 30);
    }
  } catch (e) {}
  const body = document.body;
  if (!body) return null;
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const el = node.parentElement;
      return el && !skip.has(el.tagName) && inView(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = (node.textContent || '').trim();
    if (t && re.test(t)) return t.slice(0, 30);
  }
  return null;
})()`

// ── 每轮滚动脚本（scrollToBottom 简化版：滚 window + 可滚容器 + wheel + 点「加载更多」） ──
const SCROLL_ROUND_SCRIPT = `(() => {
  const sc = document.scrollingElement || document.documentElement;
  const bigs = [];
  document.querySelectorAll('div, main, section').forEach(el => {
    try { if (el.scrollHeight > el.clientHeight + 300 && el.scrollHeight > 600) bigs.push(el); } catch (e) {}
  });
  bigs.sort((a, b) => b.scrollHeight - a.scrollHeight);
  const targets = [sc, ...bigs.slice(0, 3)];
  const wheel = (dy) => {
    try {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      document.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    } catch (e) {}
  };
  for (let i = 0; i < 5; i++) {
    targets.forEach(t => { try { t.scrollTop += 500; } catch (e) {} });
    wheel(500);
  }
  targets.forEach(t => { try { t.scrollTop = t.scrollHeight; } catch (e) {} });
  wheel(1500);
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
    const t = (b.textContent || '').trim();
    return t.includes('加载更多') || t.includes('查看更多') || t.includes('展开');
  });
  for (const b of btns.slice(0, 2)) { try { b.click(); } catch (e) {} }
  return targets.length;
})()`

// ── 登录检查脚本（每 3s 轮询）：user-info/avatar DOM 存在，或 sessionid cookie 非空 ──
const LOGIN_CHECK_SCRIPT = `(() => {
  try {
    const el = document.querySelector('[data-e2e="user-info"], [class*="user-info"], img[class*="avatar"]');
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
  } catch (e) {}
  try {
    const m = document.cookie.match(/(?:^|;)\\s*sessionid=([^;]*)/);
    if (m && m[1] && m[1].trim().length > 0) return true;
  } catch (e) {}
  return false;
})()`

// ── 高度快照（供「连续 2 轮无增长 → 到底」判定） ──
const SNAPSHOT_SCRIPT = `(() => {
  const sc = document.scrollingElement || document.documentElement;
  let bigH = 0;
  document.querySelectorAll('div, main, section').forEach(el => {
    try { if (el.scrollHeight > bigH) bigH = el.scrollHeight; } catch (e) {}
  });
  return {
    h: sc ? sc.scrollHeight : 0,
    scTop: sc ? sc.scrollTop : 0,
    innerH: window.innerHeight,
    bigH: bigH
  };
})()`

// ── 诊断脚本：底部可见文本片段（视口下半部）+ innerText 尾部 + 视口快照 ──
const DIAG_SCRIPT = `(() => {
  const sc = document.scrollingElement || document.documentElement;
  const out = [];
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return NodeFilter.FILTER_REJECT;
        if (r.bottom < window.innerHeight * 0.6 || r.top > window.innerHeight) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = (node.textContent || '').trim();
      if (t) out.push(t);
    }
  } catch (e) {}
  let innerText = '';
  try { innerText = document.body.innerText || ''; } catch (e) {}
  return {
    bottomVisibleText: out.join(' ').slice(0, 100),
    innerTextTail: innerText.slice(-200),
    scTop: sc ? sc.scrollTop : 0,
    scH: sc ? sc.scrollHeight : 0,
    innerH: window.innerHeight
  };
})()`

app.whenReady().then(async () => {
  console.log(`[probe] keyword = ${KEYWORD}`)
  console.log(`[probe] url = ${URL}`)
  console.log('[probe] window = 1024x760, partition=persist:douyin (复用登录态), show=true')

  const win = new BrowserWindow({
    show: true,
    width: 1024,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: '抖音浏览器（探针）',
    webPreferences: {
      partition: 'persist:douyin',
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.setBackgroundThrottling(false)
  win.on('close', (e) => { e.preventDefault(); win.hide() }) // 同 browser.ts：点×只隐藏

  // 加载（30s 超时防挂死）
  try {
    await Promise.race([
      win.loadURL(URL),
      new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), LOAD_TIMEOUT_MS))
    ])
    console.log('[probe] page load done')
  } catch (e) {
    console.log(`[probe] page load FAILED: ${e.message}`)
  }
  await sleep(3000) // 等首屏内容渲染（SPA）

  // 等登录（交互式）：每 3s 轮询登录信号（user-info/avatar DOM 或 sessionid cookie），最多 120s
  console.log('[login] 请在抖音窗口完成登录（扫码/密码），登录完成后程序自动继续；最多等待 120 秒')
  const LOGIN_TIMEOUT_MS = 120000
  const loginStart = Date.now()
  let loggedIn = false
  while (Date.now() - loginStart < LOGIN_TIMEOUT_MS) {
    await sleep(3000)
    let ok = false
    try { ok = await win.webContents.executeJavaScript(LOGIN_CHECK_SCRIPT) } catch (e) { /* 页面未就绪等下一轮 */ }
    if (ok) { loggedIn = true; break }
  }
  if (loggedIn) {
    console.log('[login] 已检测到登录状态（user-info/avatar 或 sessionid cookie），继续执行')
  } else {
    console.log('[login] 未检测到登录，继续执行（结果可能不典型）')
  }

  // 滚动循环：最多 12 轮，连续 2 轮高度无增长 → 判定到底
  let lastH = -1
  let stall = 0
  let bottomRound = null
  let lastSnap = null
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let targets = -1
    try {
      targets = await win.webContents.executeJavaScript(SCROLL_ROUND_SCRIPT)
    } catch (e) {
      console.log(`[round ${round}] scroll script ERROR: ${e.message}`)
      break
    }
    await sleep(ROUND_WAIT_MS)
    let snap = null
    try {
      snap = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT)
    } catch (e) {
      console.log(`[round ${round}] snapshot ERROR: ${e.message}`)
      break
    }
    lastSnap = snap
    const h = Math.max(snap.h, snap.bigH)
    const grow = h > lastH ? '↑' : '→'
    console.log(`[round ${round}] targets=${targets} scrollTop=${snap.scTop} scrollHeight=${snap.h} innerHeight=${snap.innerH} bigScrollHeight=${snap.bigH} ${grow}`)
    if (h > lastH) { lastH = h; stall = 0 }
    else { stall++; if (stall >= STALL_LIMIT) { bottomRound = round; console.log(`[probe] 连续 ${STALL_LIMIT} 轮无增长 → 判定已到底（第 ${round} 轮）`); break } }
  }
  if (!bottomRound) console.log(`[probe] ${MAX_ROUNDS} 轮内未判定到底（高度仍在增长或一直无增长但未连续 ${STALL_LIMIT} 轮）`)

  // 检测：findBottomText 同款脚本
  let found = null
  try {
    found = await win.webContents.executeJavaScript(DETECT_SCRIPT)
  } catch (e) {
    console.log(`[probe] detect script ERROR: ${e.message}`)
  }
  console.log(`[detect] findBottomText 同款脚本结果: found = ${JSON.stringify(found)}`)

  // 诊断：底部可见文本 + innerText 尾部 + 快照
  let diag = null
  try {
    diag = await win.webContents.executeJavaScript(DIAG_SCRIPT)
  } catch (e) {
    console.log(`[probe] diag script ERROR: ${e.message}`)
  }
  if (diag) {
    console.log(`[diag] bottomVisibleText(前100字) = ${JSON.stringify(diag.bottomVisibleText)}`)
    console.log(`[diag] innerTextTail(末尾200字) = ${JSON.stringify(diag.innerTextTail)}`)
    console.log(`[diag] snapshot = scrollTop=${diag.scTop} scrollHeight=${diag.scH} innerHeight=${diag.innerH}`)
  }

  // 全部输出后 3s 退出
  await sleep(3000)
  app.exit(0)
}).catch((e) => {
  console.log(`[probe] FATAL: ${e && e.stack ? e.stack : e}`)
  app.exit(1)
})
