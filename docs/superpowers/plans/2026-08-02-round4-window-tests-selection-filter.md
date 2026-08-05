# 第四轮验收修复 实施计划（窗口显示回归/失败组件测试/选择语义终版/筛选续爬修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①修抖音窗口显示回归（everShown 显示策略）；②前端组件测试基建（jsdom+testing-library）验证失败展示与选择交互；③选择语义终版（点=排他/ctrl=切换/shift=范围/框选=纯替换）；④筛选续爬修复（15s 触发 + 「暂时没有更多了」DOM 检测 + hover 面板交互）。

**Architecture:** 两个不相交工作流。A=主进程（Task 1-2），B=渲染层+测试（Task 3-5）。串行派发、逐个审查。

**Tech Stack:** 沿用；新增 devDeps `@testing-library/react` + `jsdom`（+ `@testing-library/jest-dom` 可选）。需求文档 `docs/requirements-2026-08-02d.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（138 基线 + 新增）全绿 + `npm run build`。
- 焦点策略：**首次显示 show()+blur() 不抢焦点，之后 showInactive()**；仅用户主动切浏览器 tab 聚焦。
- 选择语义：点=排他、ctrl+点=切换、shift+点=范围（锚点=最近普通/shift 点击行）、框选=纯替换、空白=清空；**取代**上轮"替换+框内翻转"。
- 筛选续爬：15s 无新视频 或 DOM「暂时没有更多了」（正则 /没有更多|到底|暂时没有/i）先到先触发；只应用一次；hover 打开面板；失败 notice 兜底。

---

### Task 1（①）: 窗口显示回归修复（everShown）

**Files:** `src/main/browser.ts`、`src/main/index.ts`

**Interfaces:** Produces: `VideoBrowser.setVisible(v, focus?)` 内部加 `everShown`——首次 `v=true` 且从未显示过：`win.show()` + `setImmediate(() => !focus && this.win?.blur())`（显示不抢焦点）；之后 `focus ? win.show() : win.showInactive()`。所有显示路径（打开按钮/tab/抓取/验证）恢复可见。

- [ ] 失败测试（无单测，逻辑简单）：typecheck + build + 人工验收（点「打开抖音窗口」出现；抓取时出现且不抢焦点；验证时出现）。
- [ ] 提交（`fix: 抖音窗口首次显示修复（show+blur 防抢焦点）`）。

### Task 2（④）: 筛选续爬修复（15s 触发 + 底部文案 + hover）

**Files:** `src/main/scheduler.ts`、`src/main/browser.ts`、`src/main/adapters/douyin.ts`、`tests/scheduler.test.ts`

**Interfaces:**
- Produces: `douyinAdapter.FILTER_SELECTORS` 增 `bottomText: /没有更多|到底|暂时没有/i`（或字符串数组）；`VideoBrowser.applyDouyinFilter(sel, f)` 交互改 hover（mouseover/mouseenter/mousemove 触发按钮，click 兼容；面板出现后点选项）；`VideoBrowser.findBottomText(): Promise<string | null>`（返回匹配的底部文案或 null）。
- Produces（scheduler）：`lastFetchedAt` 字段（handleRaw 每次 fetched++ 时更新；run 循环每轮检查 `Date.now() - lastFetchedAt > 15000`）；停滞判定处：`filterEnabled && !filterApplied && task.type==='keyword' && (findBottomText() !== null || 15s 超时)` → `filterApplied=true` → `applyDouyinFilter` → 成功重置计数继续、失败 notice+停。
- 测试：15s 触发（fake timers 或注入 now）、底部文案触发、只应用一次、失败兜底、非 keyword 不调。

- [ ] 失败测试 → 实现 → 全绿 + typecheck + build + 提交（`feat: 筛选续爬 15s+底部文案触发 hover 交互`）。

### Task 3（②）: 测试基建（jsdom + testing-library）

**Files:** `package.json`、`vitest.config.ts`、`tests/setup-renderer.ts`（新）

**Interfaces:** Produces: vitest 加 jsdom 环境（`test.environment` 按文件 glob 或 projects）；renderer 组件测试可跑（React 渲染 + fireEvent/userEvent）；`tests/helpers/` 模式保持。

- [ ] 装依赖：`npm i -D @testing-library/react @testing-library/jest-dom jsdom`；配置；一个冒烟组件测试（渲染 TaskList 头）跑绿。
- [ ] typecheck + `npx vitest run` 全绿 + 提交（`test: 渲染层组件测试基建`）。

### Task 4（③）: 选择语义终版 + 矩阵测试

**Files:** `src/renderer/src/components/TaskList.tsx`、`AuthorCollection.tsx`、`useMarqueeSelect.ts`、`tests/components/selection.test.tsx`（新）

**Interfaces:** Produces: 两表格统一选择模型——点行排他；ctrl+点切换；shift+点范围（锚点 state：最近普通/shift 点击行，ctrl 与框选不改）；框选纯替换（框住=全部选中含已选、框外取消）；空白清空；didDrag 保持。锚点/修饰键 state 放组件或抽 hook。

- [ ] 矩阵测试（`tests/components/selection.test.tsx`，用 @testing-library）：用户 6 步矩阵逐条断言（123 选中→框 234→留 234；框 567→留 567；点 1→留 1；shift+点 4→1-4；ctrl+点 5→加 5；ctrl+点 2→去 2）。
- [ ] 实现 + 测试全绿 + typecheck + build + 提交（`feat: 选择语义终版（排他/ctrl/shift/纯替换框选）+矩阵测试`）。

### Task 5（②）: 失败展示组件测试

**Files:** `src/renderer/src/errors.ts`、`tests/components/failure-display.test.tsx`（新）

**Interfaces:** Produces: 组件测试覆盖 `describeError` 全码映射（network→网络错误…含未知/空码）、失败行渲染中文原因、「只看失败」先过滤后搜索。

- [ ] 测试 + 实现补齐 → 全绿 + typecheck + 提交（`test: 失败展示组件测试`）。

---

## 执行说明

- 工作流 A = Task 1-2（窗口工程师 + 调度工程师），工作流 B = Task 3-5（前端交互工程师 + 测试基建）；各配任务审查官。
- Task 3 基建先行（Task 4/5 依赖 jsdom 环境）。
