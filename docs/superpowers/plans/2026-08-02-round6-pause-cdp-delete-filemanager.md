# 第六轮验收修复 实施计划（暂停即时/CDP筛选/程序内删视频/文件管理tab）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①爬取暂停 1 秒内即时生效（页面级中止信号）；②筛选续爬改用 CDP 真实鼠标事件（hover 下拉）；③程序内删除视频（文件+记录+计数联动）；④文件管理 tab（品类→作者二级钻取 + 批量删除）。

**Architecture:** 工作流 A=主进程（Task 1-4 主进程侧），工作流 B=渲染层（Task 3/4 UI）。串行派发、逐个审查。

**Tech Stack:** 沿用。需求文档 `docs/requirements-2026-08-02f.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（159 基线 + 新增）全绿 + `npm run build`。
- 删除 = 永久删除（确认弹窗），`path.relative` 防路径穿越，`downloadDir` 白名单。
- 暂停信号链路：主进程 send → douyin preload `ipcRenderer.on` → postMessage → 主世界滚动脚本置标志；脚本 finally 移除监听。
- CDP 失败回退合成事件，仍失败 notice 兜底不卡死。

---

### Task 1（①）: 爬取暂停即时（页面级中止信号）

**Files:** `src/main/browser.ts`、`src/preload/douyin.ts`、`src/main/scheduler.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: 滚动脚本每步检查 `__scrollAborted`（message 事件置位，finally 移除监听）；`browser.abortScroll()`（`webContents.send('dy:scroll-abort')`，fire-and-forget）；`scrollToBottom` 开始前清标志；`scheduler.pause()` 触发 `abortScroll()`。

- [ ] 失败测试（FakeBrowser 补 abortScroll spy）：pause → abortScroll 被调。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 爬取暂停即时（滚动中止信号）`）。

### Task 2（②）: 筛选续爬 CDP 真实鼠标

**Files:** `src/main/browser.ts`、`src/main/adapters/douyin.ts`、`tests/browser` 无单测（人工）

**Interfaces:** Produces: `applyDouyinFilter` 改 CDP 流程——`webContents.debugger.attach('1.3')` → 取按钮 rect → `Input.dispatchMouseEvent {type:'mouseMoved',x,y}` → 轮询 `sel.panel` 出现（executeJavaScript）→ 逐选项 rect → mouseMoved + mousePressed/mouseReleased → 等刷新 → finally detach；attach 失败回退合成事件；返回成功/失败。

- [ ] 实现 + typecheck + build + 人工验收（真机看下拉框是否打开）。

### Task 3（③）: 程序内删除视频

**Files:** `src/main/ipc.ts`、`src/main/db.ts`（video_count 重算 helper）、`src/preload/index.ts`、`src/renderer/src/components/TaskList.tsx`、`tests/db.test.ts`（可选）

**Interfaces:** Produces: `video:delete`(ids) → 每条查 local_path → 路径在 downloadDir 下（relative 校验）→ `fs.unlink`（存在才删）→ 删 DB 行 → 受影响作者 `video_count` 重算；返回删除数。UI：视频行「删除」+ 批量「删除选中」（selected 全删）+ `window.confirm`。

- [ ] 失败测试（db helper：删视频后 video_count 重算正确；ipc 路径防护用相对路径 mock）。
- [ ] 实现（main → preload → UI）+ 全绿 + typecheck + build + 提交（`feat: 程序内删除视频（文件+记录+计数联动）`）。

### Task 4（④）: 文件管理 tab

**Files:** `src/main/ipc.ts`、`src/main/db.ts`、`src/renderer/src/components/FileManager.tsx`（新）、`src/renderer/src/App.tsx`、`src/preload/index.ts`、`tests/`（files 扫描/删除 helper 可测）

**Interfaces:** Produces:
- `files:tree` → 扫描 downloadDir 一级目录=品类、二级=作者、文件=视频（跳过隐藏/临时/非 .mp4），返回 `{categories:[{name, videoCount, size, authors:[{name, videoCount, size}]}]}`。
- `files:deleteCategory`(name) / `files:deleteAuthor`(category, author) → 递归删文件夹（relative 校验在 downloadDir 内）+ DB 删该路径前缀 videos 行 + 作者 video_count 重算。
- UI：FileManager 一级品类表格（勾选/框选/删除选中/点行进二级）→ 二级作者表格（返回/批量）；复用 `useTableSelection`；`window.confirm`；删除后刷新。

- [ ] 失败测试（路径防护：../ 拒绝；树扫描 helper 对临时目录）。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 文件管理 tab（品类/作者删除）`）。

---

## 执行说明

- 串行派发：Task 1 → Task 2 → Task 3 → Task 4；每任务独立审查。
- Task 2 需真机人工验收（CDP hover 效果），审查只做代码正确性。
