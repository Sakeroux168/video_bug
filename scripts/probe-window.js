// 探针：排查抖音子窗口"完全没出现"根因（round5 Task 1）
// 运行：npx electron scripts/probe-window.js
//   默认走【修复后】定位（钳制到主显示器 workArea 内）；PROBE_BUGGY=1 复刻修复前 src/main/browser.ts 的定位逻辑（对照根因）
// CJS、零构建产物、不加载页面。全部阶段输出到 stdout 后自动退出（约 3.5s）。
'use strict'
const { app, BrowserWindow, screen } = require('electron')

const CHILD_W = 480
const CHILD_H = 760
const GAP = 24

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function boundsInside(b, w) {
  return (
    b.x >= w.x && b.y >= w.y &&
    b.x + b.width <= w.x + w.width &&
    b.y + b.height <= w.y + w.height
  )
}

/** 修复前 src/main/browser.ts 的首次定位：主窗口右侧 +24，y 取主窗口 y（原样复刻） */
function placementBuggy(hostBounds) {
  return { x: hostBounds.x + hostBounds.width + GAP, y: hostBounds.y }
}

/** 修复后：首次定位钳制到主显示器 workArea 内 */
function placementFixed(hostBounds, workArea) {
  // 主窗口未显示/最小化 → 直接 workArea 居中
  if (hostBounds.width <= 0 || hostBounds.height <= 0) {
    return {
      x: workArea.x + Math.round((workArea.width - CHILD_W) / 2),
      y: workArea.y + Math.round((workArea.height - CHILD_H) / 2)
    }
  }
  let x = hostBounds.x + hostBounds.width + GAP
  let y = hostBounds.y
  // x 超出 workArea 右缘 → 回退主窗口左侧
  if (x + CHILD_W > workArea.x + workArea.width) {
    x = hostBounds.x - CHILD_W - GAP
    // 左侧仍超出 → 贴 workArea 右缘
    if (x < workArea.x) x = workArea.x + workArea.width - CHILD_W
  }
  // y 超出 workArea 下缘 → 贴下缘
  if (y + CHILD_H > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - CHILD_H
    if (y < workArea.y) y = workArea.y
  }
  return { x, y }
}

/** 纯 JS 复刻 VideoBrowser 的创建/显示/定位逻辑（不 import 项目 TS 源码） */
class ProbeBrowser {
  constructor(host, useFixed) {
    this.host = host
    this.useFixed = useFixed
    this.win = null
    this.positioned = false
    this.everShown = false
    this.forceClose = false
  }

  async init() {
    const win = new BrowserWindow({
      parent: this.host,
      show: false,
      width: CHILD_W,
      height: CHILD_H,
      minWidth: 320,
      minHeight: 480,
      title: '抖音浏览器（探针）',
      webPreferences: {
        partition: 'persist:douyin-probe',
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.win = win
    // close → 只隐藏不销毁（同 browser.ts）
    win.on('close', (e) => {
      if (!this.forceClose) { e.preventDefault(); win.hide() }
    })
  }

  setVisible(v, focus = false) {
    if (!this.win || this.win.isDestroyed()) return
    if (v) {
      if (!this.positioned) {
        const hb = this.host.getBounds()
        const wa = screen.getPrimaryDisplay().workArea
        const p = this.useFixed ? placementFixed(hb, wa) : placementBuggy(hb)
        this.win.setPosition(p.x, p.y)
        this.positioned = true
      }
      if (!this.everShown) {
        this.everShown = true
        this.win.show()
        setImmediate(() => {
          if (!focus && this.win && !this.win.isDestroyed()) this.win.blur()
        })
      } else if (focus) {
        this.win.show()
      } else {
        this.win.showInactive()
      }
    } else {
      this.win.hide()
    }
  }

  dispose() {
    if (this.win) { this.forceClose = true; this.win.destroy(); this.win = null }
  }
}

function report(tag, browser, wa) {
  const w = browser.win
  const b = w ? w.getBounds() : null
  const host = browser.host.getBounds()
  console.log(`[${tag}] win!=null=${w != null} isVisible=${w ? w.isVisible() : '-'} minimized=${w ? w.isMinimized() : '-'}`)
  console.log(`[${tag}] child bounds=${JSON.stringify(b)}`)
  console.log(`[${tag}] host bounds=${JSON.stringify(host)}`)
  if (b && wa) console.log(`[${tag}] inside workArea=${boundsInside(b, wa)}  (workArea=${JSON.stringify(wa)})`)
}

app.whenReady().then(async () => {
  const useFixed = !process.env.PROBE_BUGGY
  console.log(`[probe] positioning = ${useFixed ? 'FIXED (clamped-to-workArea)' : 'BUGGY (current src/main/browser.ts replica)'}`)

  const prim = screen.getPrimaryDisplay()
  const displays = screen.getAllDisplays()
  console.log('[probe] displays =', JSON.stringify(displays.map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, primary: d.id === prim.id }))))
  const wa = prim.workArea
  console.log('[probe] primary workArea =', JSON.stringify(wa), ' size =', JSON.stringify(prim.size))

  // 主窗口：同 index.ts createWindow 配置
  const host = new BrowserWindow({
    width: 1280, height: 820, title: '视频爬取工具（探针宿主）',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await sleep(400) // 等 Windows 完成主窗口放置

  const browser = new ProbeBrowser(host, useFixed)
  await browser.init()

  // 阶段1：首次 setVisible(true) —— 复刻「打开抖音窗口」链路
  browser.setVisible(true)
  await sleep(500)
  report('phase1 first-show', browser, wa)

  // 阶段2：hide → 再 show 复验
  browser.setVisible(false)
  await sleep(300)
  const w2 = browser.win
  console.log(`[phase2 after hide] isVisible=${w2.isVisible()}`)
  browser.setVisible(true)
  await sleep(500)
  console.log(`[phase2 re-show]    isVisible=${w2.isVisible()} minimized=${w2.isMinimized()} bounds=${JSON.stringify(w2.getBounds())}`)

  // 阶段3：把主窗口推到 workArea 右缘，模拟真实场景（主窗口贴屏幕右边）→ 对比 buggy/fixed 落点
  host.setPosition(wa.x + wa.width - 400, wa.y + 40)
  await sleep(300)
  const hb = host.getBounds()
  const buggyP = placementBuggy(hb)
  const fixedP = placementFixed(hb, wa)
  const br = (p) => ({ x: p.x, y: p.y, width: CHILD_W, height: CHILD_H })
  console.log(`[phase3 host-at-right-edge] host=${JSON.stringify(hb)}`)
  console.log(`[phase3 buggy] x=${buggyP.x} y=${buggyP.y} rightEdge=${buggyP.x + CHILD_W} bottomEdge=${buggyP.y + CHILD_H} → inside workArea=${boundsInside(br(buggyP), wa)}`)
  console.log(`[phase3 fixed] x=${fixedP.x} y=${fixedP.y} rightEdge=${fixedP.x + CHILD_W} bottomEdge=${fixedP.y + CHILD_H} → inside workArea=${boundsInside(br(fixedP), wa)}`)

  // 阶段3b：实建窗口验证修复后定位的真实落点
  const b3 = new ProbeBrowser(host, true)
  await b3.init()
  b3.setVisible(true)
  await sleep(500)
  report('phase3b fixed-real', b3, wa)

  // 收尾：销毁全部窗口 → 强制退出
  b3.dispose()
  browser.dispose()
  host.destroy()
  await sleep(100)
  app.exit(0)
})
