# 第三轮验收修复 实施计划（窗口焦点/滚动速度/选择语义/失败可视化/筛选续爬）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①抖音窗口程序化显示不抢焦点；②滚动速度三档+数字可配且默认更慢；③选择交互改"排他点击 + 框选替换翻转"；④下载失败显示中文原因+只看失败；⑤搜索到底用抖音自带筛选续爬。

**Architecture:** 两个不相交工作流。A=主进程/注入（T1-T3），B=渲染层（T4-T5）。串行派发、逐个审查。

**Tech Stack:** 沿用。需求文档 `docs/requirements-2026-08-02c.md`（验收标准底线）。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（132 用例）全绿 + `npm run build`。
- 焦点策略：**程序化显示一律不抢焦点**；仅用户主动切「内置浏览器」tab 时才聚焦。
- 框选语义：结果 = 框住集合 ∖ 原有已选（替换+框内翻转）；点行 = 排他（点已选中=清空）。
- 筛选续爬：**只应用一次**、仅 keyword 任务、选择器失效不卡死有提示。

---

### Task 1（T1）: 窗口焦点策略（showInactive）

**Files:** `src/main/browser.ts`、`src/main/index.ts`

**Interfaces:** Produces: `VideoBrowser.setVisible(v: boolean, focus?: boolean)`——`focus=true` 时 `show()`（用户主动），否则 `showInactive()`；`focus()` 方法移除或仅内部用。`index.ts`：`setBrowserVisible`（用户切 tab）传 `true`；`updateBrowserDisplay`（任务/验证程序化）传默认 `false`；stalled_verify 分支删掉 `browser.focus()`。

- [ ] 实现 browser.ts setVisible 双模式 + index.ts 调用点区分。
- [ ] typecheck + build；人工验收：抓取时窗口弹出不抢焦点，点 tab 才聚焦。

### Task 2（T2）: 滚动速度三档 + 数字微调

**Files:** `src/main/settings.ts`、`src/shared/types.ts`、`src/main/browser.ts`、`src/main/scheduler.ts`

**Interfaces:** Produces: `AppSettings.scrollSpeed: 'slow'|'medium'|'fast'`（默认 slow）、`scrollPageWaitMs: number`（默认 8000）；`browser.scrollToBottom(opts?: { waitMs?: number })`（waitForGrowth 超时参数化）；`Scheduler` 每次 `run()` 从 `getSettings()` 现读滚动参数（设置保存即生效，无需重启）。

- [ ] 实现：设置项 + browser 参数化 + scheduler 现读；慢/中/快 = 8s/5s/3s 作为 waitMs 默认。
- [ ] typecheck + build + 人工验收（设置页三档+数字生效）。

### Task 3（T3）: 抖音筛选续爬

**Files:** `src/main/adapters/douyin.ts`、`src/main/injector.ts`（或 browser.ts）、`src/main/browser.ts`、`src/main/scheduler.ts`、`src/main/index.ts`、`src/renderer/src/components/FilterForm.tsx`、`src/shared/types.ts`、`tests/scheduler.test.ts`

**Interfaces:**
- Produces: `douyinAdapter.FILTER_SELECTORS = { button: 'span.bR4uhU1W', panel: 'div.IMWRHJOg', option: (g, o) => \`span[data-index1="${g}"][data-index2="${o}"]\` }`
- `Filters.douyinFilter?: { enabled: boolean; publishTime: number; duration: number; searchScope: number; contentType: number }`（索引，0=不限，存 filters JSON）
- `VideoBrowser.applyDouyinFilter(sel, filters): Promise<boolean>`（executeJavaScript：点筛选按钮→等面板→对每组 index>0 点选项→等 2.5s 页面刷新→返回成功）
- `SchedulerEvent` 增 `{ type: 'task:notice'; text: string }`；`index.ts push()` 转发 `evt:task:notice`
- Produces（scheduler 逻辑）：停滞（连续 2 轮无新内容）且 `fetched < target` 且 `filters.douyinFilter?.enabled` 且 `task.type==='keyword'` 且未应用过 → `applyDouyinFilter` → `filterApplied=true`、重置 emptyRounds/silentRounds 继续；脚本失败/抛错 → emit notice「筛选续爬未生效（页面结构可能已变）」+ 按原逻辑停
- FilterForm：开关 + 4 下拉（发布时间 0-3 / 时长 0-3 / 搜索范围 0-3 / 内容形式 0-2，值=索引）

- [ ] 失败测试：scheduler 停滞时启用筛选→applyDouyinFilter 被调且只一次；失败→notice+停；非 keyword/未启用→不调。
- [ ] 实现 + 全绿 + typecheck + build + 提交。

### Task 4（T4）: 失败可视化

**Files:** `src/renderer/src/errors.ts`（新）、`src/renderer/src/components/TaskList.tsx`

**Interfaces:** Produces: `describeError(code: string): string`（network→网络错误，address_expired→下载链接已过期，forbidden→平台拒绝（可能风控），login_expired→登录已过期，disk→磁盘错误（空间/权限），parse_error→文件解析失败，ai_auth→AI认证失败，ai_quota→AI额度用尽，ai_timeout→AI超时，bad_mp4→文件校验失败，其它→原文）。
- TaskList 视频表格：失败行状态旁显示原因（小字）；工具栏「只看失败」开关（过滤 status==='failed'）。

- [ ] 实现 + typecheck + build + 人工验收。

### Task 5（T5）: 选择语义（排他点击 + 框选替换翻转）

**Files:** `src/renderer/src/components/TaskList.tsx`、`AuthorCollection.tsx`

**Interfaces:** Produces: 点行 = `setSelected(行已选 ? new Set() : new Set([id]))`；框选 endDrag = `setSelected(new Set([...covered].filter(id => !prevSelected.has(id))))`；空白清空保持；didDrag 防误伤保持；批量按钮计数兼容（跨页完整 selected 过滤保持）。

- [ ] 实现两表格 + typecheck + build + 人工验收（验证场景：框 1-5 再框 3-8 → 留 6-8）。

---

## 执行说明

- 工作流 A = Task 1-3（主进程/注入），工作流 B = Task 4-5（渲染层）；各 1 个实现 agent + 1 个审查。
- T3 是重头（注入脚本 + 触发逻辑 + 配置 UI），单测覆盖触发/只一次/失败兜底。
