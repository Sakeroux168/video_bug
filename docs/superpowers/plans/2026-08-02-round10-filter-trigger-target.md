# 第十轮验收修复 实施计划（筛选触发修复/目标数量自由/测试按钮移位）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①筛选续爬触发判断移出停滞分支（每轮检查到底文案/15s，修复"到底不触发"+"爬不完目标"）；②目标数量 1-1000 自由设置；③手动测试按钮移入筛选条件模块。

**Architecture:** 两个任务串行派发、逐个审查。需求文档 `docs/requirements-2026-08-02i.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（261 基线 + 新增）全绿 + `npm run build`。
- 触发条件：`enabled && keyword && !filterApplied && (findBottomText() || 15s)`；FILTER_BUSY 重试/成功重置/失败 notice 兜底逻辑全部保留。
- target 校验 1-1000；默认 200 不变；scheduler `?? 200` 不变。

---

### Task 1（①）: 筛选触发移出停滞分支

**Files:** `src/main/scheduler.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: `run` 循环内（停滞分支**之前**或独立检查点）每轮检查触发条件；findBottomText 每 2 轮查一次（`roundCount % 2 === 0`，注释说明开销权衡）；触发后沿用：成功 → `emptyRounds=0` 重置继续；失败/异常 → notice + `filterApplied=true` 停；FILTER_BUSY → 不消耗继续重试。停滞分支保留（无筛选配置时正常停）。

- [ ] 失败测试：有零星数据（每轮 kept>0 重置 emptyRounds）时，到底文案命中 → 仍触发（旧实现不触发）；15s 超时 → 触发；未启用/非 keyword/已应用 → 不触发。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`fix: 筛选触发移出停滞分支`）。

### Task 2（②③）: 目标数量 1-1000 + 测试按钮移位

**Files:** `src/renderer/src/components/FilterForm.tsx`、`src/renderer/src/App.tsx`、`tests/components/filter-form.test.tsx`（若存在）

**Interfaces:** Produces: `target` 校验 `>=1 && <=1000`（文案「目标数量需在 1-1000 之间」）；「测试筛选」按钮从 App 头部移除、放入 FilterForm 筛选续爬配置区（4 个下拉旁，调 `api.testFilter()`——确认 preload/api 里 debug:testFilter 的方法名，`testFilter` 或新增）；按钮防重/结果 notify 保持。

- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 目标数量1-1000+测试按钮移位`）。

---

## 执行说明

- 串行派发 Task 1 → Task 2；每任务独立审查。
- Task 1 真机验收：到底显示「暂时没有更多了」→ 自动触发。
