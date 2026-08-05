# 第九轮验收修复 实施计划（窗口独立化/最小尺寸/遮挡检测）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①抖音窗口去掉 `parent`（独立普通窗口，点谁谁在上，解决"一直盖住程序"）；②窗口默认/最小尺寸设到抖音布局不裁剪的宽度（解决"缩小后筛选键被裁出窗外"）；③悬停前 elementFromPoint 遮挡/视口检测打点（诊断兜底）。

**Architecture:** 两个任务串行派发、逐个审查。方案 A（用户已确认，不做内嵌重构 B）。

## Global Constraints

- TS strict；2 空格/分号/中文注释。
- 回归底线：`npm run typecheck` + `npx vitest run`（261 基线）全绿 + `npm run build`。
- 去 parent 后：close→hide、before-quit dispose、主窗口 close→dispose 逻辑必须仍成立（独立窗口在主窗口关闭后不能残留）。

---

### Task 1（①）: 抖音窗口独立化 + 最小尺寸

**Files:** `src/main/browser.ts`

**Interfaces:** Produces: `new BrowserWindow({ ... })` 去掉 `parent: host`；默认 `width: 1024, height: 760`；`minWidth: 900, minHeight: 600`（抖音搜索页布局不被裁剪的下限，实测后微调）；`everShown` 首定位逻辑保留（相对主窗口右侧，越界钳制已存在）。

- [ ] 实现 + 核对退出链路（close→hide 仍生效；主窗口 close → `browser?.dispose()` 仍销毁独立窗口；before-quit dispose）→ typecheck + build + 提交（`feat: 抖音窗口独立化+最小尺寸`）。

### Task 2（②）: 悬停前遮挡/视口检测

**Files:** `src/main/browser.ts`

**Interfaces:** Produces: `cdpFilterPath` 悬停按钮前，executeJavaScript 内 `document.elementFromPoint(x, y)` 检查——命中元素是按钮本身或其子元素 → 正常；否则打点「按钮可能被遮挡或在视口外（命中元素: <tag.class>）」并**仍尝试悬停**（万一 elementFromPoint 因滚动偏移误判）；结合 scrollIntoView 已居中。窄窗口下按钮被裁出视口时，elementFromPoint 返回边缘元素/按钮坐标在视口外 → 日志明确提示「窗口过窄，请拉宽抖音窗口」。

- [ ] 实现 + typecheck + build + 提交（`feat: 筛选悬停前遮挡检测`）。

---

## 执行说明

- 串行派发 Task 1 → Task 2；每任务独立审查。
- 真机验收：抖音窗口不再一直盖程序（点谁谁在上）；窗口缩到最小时筛选键不再被裁（minWidth 兜底）；手动测试筛选日志无「遮挡」提示。
