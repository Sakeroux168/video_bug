import { Menu, Notification, Tray, nativeImage, type BrowserWindow } from 'electron'
import trayIconPath from '../../resources/tray.png?asset'
import type { Notice } from './automation'

/**
 * 托盘和系统通知（2026-10-07 自动化）。
 * 托盘图标一直在：点它打开主窗口；右键菜单能「现在追更一次」「退出」。
 * 设置里开了「关窗口缩到托盘」时，点 × 只是藏起来，程序在后台继续抓、继续下载、到点追更。
 */

export function showMainWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function createTray(deps: { getWindow: () => BrowserWindow | null; onFollowNow: () => void; onQuit: () => void }): Tray {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath))
  tray.setToolTip('视频爬取工具')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow(deps.getWindow()) },
    { label: '现在追更一次', click: () => deps.onFollowNow() },
    { type: 'separator' },
    { label: '退出', click: () => deps.onQuit() }
  ]))
  tray.on('click', () => showMainWindow(deps.getWindow()))
  return tray
}

/** 弹一条系统通知；点通知打开主窗口 */
export function showNotice(n: Notice, getWindow: () => BrowserWindow | null): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: n.title, body: n.body, icon: nativeImage.createFromPath(trayIconPath) })
  notification.on('click', () => showMainWindow(getWindow()))
  notification.show()
}

/** 窗口在前台时不弹（界面里已经有提示了） */
export function windowInFront(win: BrowserWindow | null): boolean {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
}
