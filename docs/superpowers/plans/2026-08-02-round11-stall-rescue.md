# 第十一轮验收修复 实施计划（5秒停滞检测 + 爬不动自动自救循环）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①停滞检测改为秒数制（设置可配，默认 5s，替代空轮数依赖）；②爬不动自动自救循环（筛选一次 → 重搜关键词 ≤3 次 → 爬满为止）；③无策略可用时真正暂停；④UI 显示已重搜次数。

**Architecture:** 两个任务串行派发、逐个审查。需求文档 `docs/requirements-2026-08-02j.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（314 基线 + 新增）全绿 + `npm run build`。
- 停滞阈值：`AppSettings.stallThresholdSec` 默认 5，每次 run 现读 getSettings()（保存即生效）；15s 旧规则删除。
- 自救循环：停滞 → 到底文案命中（可见性+视口校验）→ 筛选未应用则应用一次；已应用或非到底 → 重搜（`browser.load` 搜索 URL）≤3 次；超限/无策略 → 暂停 + notice。
- 重搜后 `seen` 去重只收新；`filterApplied`/`reSearchCount` 每 run 重置；progress 事件带 `reSearchCount`。

---

### Task 1（①②③）: 调度器自救循环

**Files:** `src/main/scheduler.ts`、`src/main/settings.ts`、`src/shared/types.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces:
- `AppSettings.stallThresholdSec: number`（默认 5，types.ts + settings.ts DEFAULTS）。
- Scheduler：`lastFetchedAt` 停滞判定改为 `Date.now() - lastFetchedAt > stallThresholdSec * 1000`（run 现读 getSettings()）；停滞时进入自救逻辑：
  1. `findBottomText()` 命中且 `!filterApplied` 且启用 → 应用筛选（现有流程，FILTER_BUSY 重试保留）→ 成功重置计数继续；
  2. 否则（筛选已应用/未启用/非到底连续 2 轮）→ `reSearchCount < 3` 时 `browser.load(adapter, buildSearchUrl(query, filters))` 重搜 → `reSearchCount++` → 重置停滞计数继续；进度事件带 `reSearchCount`；
  3. `reSearchCount >= 3` 或未启用筛选 → 暂停（`paused`，error='stalled'）+ notice「爬取停滞已自动暂停」/「已重搜 3 次仍爬不满」。
- 旧 15s 规则删除；`emptyRounds` 仅日志用。
- 失败测试：5s 停滞触发筛选（阈值可注入/fake timers）；筛选后再停滞 → 重搜（load 被调、URL 正确、reSearchCount 递增）；重搜 3 次超限 → paused+notice；未启用 → 停滞直接 paused；爬满 → done 不变。

### Task 2（设置+UI）: 停滞阈值设置 + 已重搜次数显示

**Files:** `src/renderer/src/components/SettingsPanel.tsx`、`src/renderer/src/components/TaskList.tsx`、`src/preload/index.ts`（若类型需扩展）

**Interfaces:** Produces: SettingsPanel「运行参数」加「停滞检测(秒)」数字输入（默认 5，保存生效）；TaskList 任务行在 `reSearchCount > 0` 时显示「已重搜 N 次」（消费 progress 事件扩展字段，`task:progress` 透传）；重搜发生时 notice（复用 evt:task:notice）。

- [ ] 实现 + typecheck + build + 提交。

---

## 执行说明

- 串行派发 Task 1 → Task 2；每任务独立审查。
- 真机验收：卡 5 秒 → 日志「停滞检测」→ 自动筛选/重搜 → 任务行显示「已重搜 N 次」。
