# 第十二轮实施计划（删除抖音筛选/重搜唯一自救/默认放慢）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①删除抖音筛选续爬全功能（用户确认：筛选取缔，系统简化）；②重搜成为唯一自救（停滞 → 重搜，10 秒冷却可设置，到底文案命中立即重搜不受冷却；≤3 次后暂停）；③默认滚动放慢降风控。

**Architecture:** 两个任务串行派发、逐个审查。

## Global Constraints

- TS strict；2 空格/分号/中文注释。
- 回归底线：`npm run typecheck` + `npx vitest run`（337 基线）全绿 + `npm run build`。
- **删除清单**（主进程）：scheduler 的 douyinFilter 分支（df 检查/applyDouyinFilter 调用/FILTER_SELECTORS 引用）；browser.ts 的 `applyDouyinFilter`/`cdpFilterPath`/`legacyFilterPath`/`locateElement` 筛选相关；douyin.ts 的 `FILTER_SELECTORS`/`resolveSelector`（若仅筛选用）；FilterForm 的开关+4 下拉+静默测试按钮；App 头部「手动测试筛选」按钮；`debug:testFilter` IPC。
- **保留**：findBottomText（到底检测）、findVerifyIndicator（验证码暂停）、withTimeout 长操作超时、秒级心跳、abortScroll。
- **重搜改造**：停滞 → 重搜（冷却 `rescueCooldownSec` 默认 10，设置可调）；到底文案命中 → 立即重搜（不受冷却）；重搜 ≤3 次 → 暂停+notice。
- **放慢**：`scrollIntervalMs` 默认 2000→3500；滚动脚本步进延迟 450ms→550ms。

---

### Task 1（主进程）: 删筛选 + 重搜唯一自救 + 放慢

**Files:** `src/main/scheduler.ts`、`src/main/browser.ts`、`src/main/adapters/douyin.ts`、`src/main/ipc.ts`（debug:testFilter）、`src/main/settings.ts`、`src/shared/types.ts`、`tests/scheduler.test.ts`、`tests/browser.test.ts`、`tests/douyin-adapter.test.ts`、`tests/browser-click-options.test.ts`（删除）

**Interfaces:** Produces:
- `AppSettings.rescueCooldownSec: number`（默认 10，settings.ts DEFAULTS + types.ts）。
- Scheduler：删除筛选分支；停滞自救 = 重搜（`Date.now() - lastRescueAt < cooldown*1000` 时跳过本轮继续等；到底文案命中 → 忽略冷却立即重搜）；重搜计数/上限/notice 保留；验证码/超时/心跳保留。
- browser.ts：删除 applyDouyinFilter/cdpFilterPath/legacyFilterPath/locateElement/FILTER_SELECTORS 引用；保留 findBottomText/findVerifyIndicator/withTimeout/scrollToBottom/abortScroll。
- douyin.ts：删除 FILTER_SELECTORS/resolveSelector（确认无其它引用）。
- ipc.ts：删除 debug:testFilter。
- 放慢：settings scrollIntervalMs 默认 3500；scrollToBottom 脚本 450→550ms。

- [ ] 更新/删除相关测试 → 全绿 + typecheck + build + 提交（`refactor: 删除抖音筛选，重搜唯一自救+默认放慢`）。

### Task 2（渲染层）: 删筛选 UI + 测试按钮

**Files:** `src/renderer/src/components/FilterForm.tsx`、`src/renderer/src/App.tsx`、`src/preload/index.ts`（testFilter 删除）、`tests/components/filter-form.test.tsx`（更新）、`tests/ipc-author-dedup.test.ts`（若引用 testFilter）

**Interfaces:** Produces: FilterForm 删除筛选续爬开关+4 下拉+静默测试按钮；App 头部删除「手动测试筛选」按钮与 testFilterBusy；preload 删除 testFilter；组件测试更新（筛选相关用例删除，target/其它保留）。

- [ ] 全绿 + typecheck + build + 提交（`refactor: 删除筛选 UI 与测试按钮`）。

---

## 执行说明

- 串行派发 Task 1 → Task 2；每任务独立审查。
- 真机验收：无筛选配置痕迹；卡住 10 秒冷却后重搜；到底立即重搜。
