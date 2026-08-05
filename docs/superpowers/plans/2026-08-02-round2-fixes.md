# 第二轮验收修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 修 3 个爬取控制 bug（暂停即时/硬截断/滚动等加载）、归档总是自动 + 时长二级目录（60s 界）、任务/作者两页表格重组、选择交互重做。

**Architecture:** 两个不相交工作流：主进程（scheduler/browser/organizer/index）与渲染层（App/TaskList/AuthorCollection）。串行派发、逐个审查。

**Tech Stack:** 沿用（Electron 35 + electron-vite + React + TS + node:sqlite + vitest）。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（125 用例）全绿；`npm run build` 成功。
- 时长分界：`duration <= 60` → 一分钟内；`> 60` → 一分钟外（videos.duration 单位秒）。
- 归档：总是触发（去「AI 下载后整理」勾选依赖）；AI 只管品类。
- 目录名沿用 `sanitizeCategory`/`sanitizeDirName`（organizer.ts 导出）。

---

### Task 1（A1）: 暂停即时打断 + 继续不丢

**Files:** `src/main/scheduler.ts`、`src/main/ipc.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: `Scheduler.pause(): Promise<void>`（置 aborted + 打断当前等待 + 等 run() 完全退出）；`Scheduler` 内部可中断 sleep（`stop()/pause()` 即时唤醒）；run 循环在 `scrollToBottom` 前检查 aborted 提前 break。

- [ ] 失败测试：暂停后（不等待）立刻 resume → 任务恢复运行（fake timers 或短间隔下）；pause() 的 promise 在 run 退出后 resolve。
- [ ] 实现：`abortWait` 存当前 sleep 的 resolve；`pause()` 触发后 `await runExit`；run 的 finally 里 resolve runExit。
- [ ] ipc `task:pause`：`await scheduler.pause()` 后再置 status。
- [ ] 全绿 + typecheck + 提交。

### Task 2（A2）: 抓取硬截断到目标

**Files:** `src/main/scheduler.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: `handleRaw` 插入前 `remaining = target - fetched`，`batch = kept.slice(0, max(0, remaining))`；AI 过滤与插入都只处理 batch 内条目；`fetched` 恰好到达 target。

- [ ] 失败测试：target=200、当前 fetched=195、一批解析 10 条去重后 8 条 → 只插 5 条，fetched=200，DB 不超。
- [ ] 实现 + 全绿 + typecheck + 提交。

### Task 3（A3）: 滚动等待当页加载

**Files:** `src/main/browser.ts`（scrollToBottom 注入脚本）、`tests/browser` 无单测（人工验收）

**Interfaces:** Produces: 每轮滚动后轮询（250ms）等待 `scrollHeight` 增长或列表条目数增长，最多等 4s；增长才进下一轮；无增长提前继续（防卡死）。

- [ ] 实现注入脚本改动（滚动后 `waitForGrowth(round)`：记基线 → 滚到底 → 轮询直到高度/条目数变化或超时）。
- [ ] `npm run build` 通过；人工验收：小网速下每页明显停留更久。

### Task 4（B）: 归档总是自动 + 时长二级目录

**Files:** `src/main/scheduler.ts`（onEvent 去 aiOrganizeEnabled 条件）、`src/main/organizer.ts`（时长子目录）、`tests/organizer.test.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: `organizeAuthor` 目标 `{downloadDir}/{品类}/{作者昵称}/{一分钟内|一分钟外}/{filename}`（按 videos.duration 分桶）；下载 done → 无条件 `markAuthorPending`（organizer 存在时）。

- [ ] 失败测试：organizer 60s→一分钟内、61s→一分钟外；scheduler done（无 aiOrganizeEnabled）→ markAuthorPending 被调。
- [ ] 实现：organizeAuthor 移文件时按 duration 分桶（沿用 isFlat 幂等）；scheduler 去条件。
- [ ] 全绿 + typecheck + 提交。

### Task 5（C）: 任务/作者两页表格重组

**Files:** `src/renderer/src/App.tsx`、`src/renderer/src/components/TaskList.tsx`、`AuthorCollection.tsx`、`BrowserPanel.tsx`

**Interfaces:** Produces: tab = 任务（FilterForm + TaskList）/ 作者收藏（AuthorCollection）/ 内置浏览器 / 设置；TaskList 任务区改表格行（点击行展开视频表格，保留下载/暂停/继续/删除操作）；AuthorCollection 独立成页。

- [ ] 实现 tab 重组 + TaskList 表格化 + AuthorCollection 页。
- [ ] typecheck + build + 人工验收（布局、展开、下载操作可用）。

### Task 6（D）: 选择交互重做（行切换/空白清空/框选替换）

**Files:** `src/renderer/src/components/TaskList.tsx`、`AuthorCollection.tsx`

**Interfaces:** Produces: 点行任意位置切换选中（勾选框/链接/按钮除外）；点空白清空选择；框选（拖动）= 替换式（框住的选中、框外取消）；与既有批量按钮兼容。

- [ ] 实现（TaskList 加行切换/空白清空/替换式框选；AuthorCollection 框选改替换式 + 行切换/空白清空）。
- [ ] typecheck + build + 人工验收。

---

## 执行说明

- 工作流 1 = Task 1-4（主进程），工作流 2 = Task 5-6（渲染层）；串行派发，每任务实现后独立审查。
- 本计划不新增依赖、不动 DB schema（时长用 videos.duration 现算）。
