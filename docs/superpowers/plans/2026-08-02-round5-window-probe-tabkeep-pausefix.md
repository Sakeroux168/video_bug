# 第五轮验收修复 实施计划（窗口不显示排查/任务页参数保留/下载暂停增强）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①窗口探针排查"完全没出现"根因并修复；②任务页 tab 切换参数保留（常驻挂载）；③下载暂停增强（全局暂停中断在途 + 单条暂停/继续）。

**Architecture:** 工作流 A=主进程（Task 1 窗口、Task 3 下载引擎），工作流 B=渲染层（Task 2、Task 3 UI）。串行派发、逐个审查。

**Tech Stack:** 沿用。需求文档 `docs/requirements-2026-08-02e.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（149 基线 + 新增）全绿 + `npm run build`。
- 焦点策略保持（首次 show+blur、之后 showInactive、用户 tab 聚焦）。
- 下载暂停：全局 pause 中断在途（AbortController）且保留队列位置；per-video pause/resume（新状态 `paused`）；**不做**字节级 Range 续传；重启后 `paused` 项不自动下载。
- 任务页常驻挂载（CSS hidden），不跨重启持久化。

---

### Task 1（①）: 窗口"完全没出现"探针排查 + 根因修复

**Files:** 探针脚本（`scripts/probe-window.js` 或 tests 下临时，排查后删除或保留）、`src/main/browser.ts`、`src/main/index.ts`

**Interfaces:** Produces: 探针——创建主窗口 + VideoBrowser（走真实 preload/init），`setVisible(true)` 后记录：`win` 非空？`isVisible()`？`getBounds()` vs `screen.getPrimaryDisplay().workArea`；再模拟 IPC 链路（browser:show 到达 setBrowserVisible）；全部输出到 stdout 后自动退出（3-5s）。根据输出定位根因修复（嫌疑：首次定位 `host.getBounds().x + width + 24` 超出工作区 → 屏幕外；或 show 路径未到达；或窗口被隐藏/销毁）。

- [ ] 实现探针 → 本机实跑 `npx electron scripts/probe-window.js` 拿真实输出
- [ ] 定位根因 → 修复（如：定位钳制到 `workArea` 内 + 屏幕右缘溢出回退到主窗口居中/左侧）
- [ ] 探针复验（isVisible=true 且 bounds 在 workArea 内）→ typecheck/build → 提交（`fix: 抖音窗口不显示根因修复`）
- [ ] 人工复测点写入报告：点「打开抖音窗口」应出现

### Task 2（②）: 任务页常驻挂载（tab 切换参数保留）

**Files:** `src/renderer/src/App.tsx`、`src/renderer/src/components/FilterForm.tsx`（如需要）

**Interfaces:** Produces: 任务 tab 内容（FilterForm + TaskList）在非激活 tab 时用 CSS `hidden` 隐藏而非卸载；切回原样（参数/展开状态/进度订阅保留）。

- [ ] 实现（App.tsx 渲染结构调整）+ typecheck/build + 人工验收（输入参数切 tab 切回保留）

### Task 3（③）: 下载暂停增强

**Files:** `src/main/downloader.ts`、`src/shared/types.ts`（VideoStatus 增 `paused`）、`src/main/db.ts`（taskStats 增 paused 计数）、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/src/components/TaskList.tsx`（行内暂停/继续按钮 + 状态文案）、`tests/downloader.test.ts`、`tests/db.test.ts`

**Interfaces:**
- Produces: `Downloader.pause()`：置 paused + **中断在途**（abort 现有 AbortController；AbortError 路由：`this.paused` → 标 `pending` + 重新入队，非 paused → `cancelled` 不变）；`resume()`：清 paused + drain（被中断的在途已回队）；`pauseVideo(id)`：在途 abort + 出队 + 标 `paused`；`resumeVideo(id)`：`paused` → `pending` + enqueue；`VideoStatus` 增 `'paused'`；`taskStats` 增 `paused` 计数。
- Produces（ipc/preload）：`video:pause`(ids)/`video:resume`(ids)。
- Produces（UI）：TaskList 视频行对 `pending/downloading` 显示「暂停」、`paused` 显示「继续」；状态文案「已暂停」；统计行补 paused 计数。
- 重启：`paused` 项不进入重启重排（只重排 `pending`）。

- [ ] 失败测试：全局 pause 中断在途（fetch 收到 abort、状态回 pending、resume 后重新下载）；per-video pause（在途/排队两路径）；resumeVideo；AbortError 路由区分（全局暂停 vs 用户取消）；taskStats paused 计数；重启不重排 paused
- [ ] 实现（downloader → db/types → ipc/preload → UI）→ 全绿 + typecheck + build → 提交（`feat: 下载暂停增强（全局中断在途+单条暂停/继续）`）

---

## 执行说明

- 工作流 A = Task 1、Task 3 主进程；工作流 B = Task 2、Task 3 UI。串行派发（Task 1 → Task 2 → Task 3）。
- Task 1 探针在本机实跑（用户机器），会短暂弹出窗口，属预期调试行为。
