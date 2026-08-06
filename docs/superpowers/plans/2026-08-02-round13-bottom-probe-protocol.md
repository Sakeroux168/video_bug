# 第十三轮实施计划（先滚到底再检测/bytedance拦截/实机探测）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①停滞自救先滚到底再检测"暂时没有更多了"（提示只在视口内可见时才能被 DOM 检测到）；②拦截 bytedance:// 等自定义协议弹窗（will-frame-navigate/will-redirect 子框架与重定向漏网）；③测试 agent 实机探测"滑到底后 findBottomText 能否截到提示"。

## Global Constraints

- TS strict；2 空格/分号/中文注释。
- 回归底线：`npm run typecheck` + `npx vitest run`（290 基线）全绿 + `npm run build`。
- findBottomText 语义保持（可见性+视口校验）；只改调用时机（先滚到底）。
- bytedance 拦截：非 https 一律 preventDefault（主框架已有，补子框架+重定向）。

---

### Task 1（③）: 实机探测"滑到底能否截到提示"

**Files:** `scripts/probe-bottom.js`（新，调试脚本，可保留）、报告

**Interfaces:** Produces: 探针——创建抖音窗口（复用 VideoBrowser 同款配置：partition persist:douyin 登录态）→ 加载搜索页（关键词参数）→ `scrollToBottom`（复用注入脚本逻辑或简化版滚到底）→ 等 2s → 执行 findBottomText 同款脚本 → 输出：页面高度/视口位置/底部文案命中结果（命中文本 or null）+ 页面可见的尾部文本片段（前 100 字，供判断真实提示文案）→ 3s 后退出。实机跑 `npx electron scripts/probe-bottom.js <关键词>`。

- [ ] 实现探针 → 实跑拿真实结果（记入报告：命中/未命中、提示文案实际内容）→ 提交（`test: 底部提示实机探测脚本`）。

### Task 2（①）: 停滞先滚到底再检测

**Files:** `src/main/scheduler.ts`、`tests/scheduler.test.ts`

**Interfaces:** Produces: 停滞自救逻辑改为——先 `await scrollToBottom`（确保在页底）→ `findBottomText()` → 命中 → 立即重搜（忽略冷却）；未命中 → 走冷却重搜。日志打点「已滚到底，检测提示 → 命中/未命中」。

- [ ] 失败测试：停滞时 findBottomText 前先调 scrollToBottom（spy 顺序）；命中 → 立即重搜；未命中 → 冷却重搜。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 停滞先滚到底再检测底部提示`）。

### Task 3（②）: bytedance:// 弹窗拦截

**Files:** `src/main/browser.ts`

**Interfaces:** Produces: 抖音窗口 webContents 补 `will-frame-navigate`（子框架，非 https 阻止）+ `will-redirect`（重定向到非 https 阻止）——主框架 will-navigate 已有；自定义协议（bytedance:// 等）全拦死。

- [ ] 实现 + typecheck + build + 提交（`fix: 拦截 bytedance 等自定义协议弹窗`）。

---

## 执行说明

- 串行派发 Task 1（探测，先于代码改动，验证前提）→ Task 2 → Task 3；每任务独立审查。
- 探测会短暂弹出抖音窗口（登录态复用），属预期调试行为。
