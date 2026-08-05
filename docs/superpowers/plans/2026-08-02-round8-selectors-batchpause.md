# 第八轮验收修复 实施计划（筛选选择器加固/批量暂停继续）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①筛选续爬选择器多候选加固（哈希类名过期 → 文字/语义属性兜底）；②视频表格批量暂停/继续按钮。

**Architecture:** 两个任务串行派发、逐个审查。需求文档 `docs/requirements-2026-08-02h.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（231 基线 + 新增）全绿 + `npm run build`。
- 选择器候选顺序：哈希类 → 文字/语义属性；全部失败才返回 false（不卡死，日志打点每步候选命中情况）。

---

### Task 1（①）: 筛选选择器多候选加固

**Files:** `src/main/adapters/douyin.ts`、`src/main/browser.ts`、`tests/douyin-adapter.test.ts`

**Interfaces:** Produces: `FILTER_SELECTORS` 改为多候选结构——
- button: `[{ type:'css', sel:'span.bR4uhU1W' }, { type:'text', text:'筛选' }]`
- panel: `[{ type:'css', sel:'div.IMWRHJOg' }, { type:'text', contains:['排序依据','视频时长'] }]`
- option(g,o): 先 `span[data-index1="${g}"][data-index2="${o}"]`，找不到面板内按文字匹配选项名（选项名映射表：时长 1分钟以下/1-5分钟/5分钟以上、范围 关注的人/最近看过/还未看过、发布时间 一天内/一周内/半年内、内容形式 视频/图文）
- 导出纯函数 `resolveSelector(candidates)`（测试用）；`browser.ts` 的 center/轮询按候选依次尝试并打点（`[筛选] 按钮候选1未命中，候选2(文字'筛选')命中`）。
- 失败测试：纯函数候选解析（css 命中优先、css 缺失文字命中、都缺 null）；选项文字映射。

- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 筛选选择器多候选加固`）。

### Task 2（②）: 视频表格批量暂停/继续

**Files:** `src/renderer/src/components/TaskList.tsx`

**Interfaces:** Produces: 工具栏（下载选中/取消选中/重试选中旁）加「暂停选中(N)」（selected ∩ {pending,downloading} → `api.pauseVideos(ids)` 即 video:pause）与「继续选中(N)」（selected ∩ {paused} → `api.resumeVideos(ids)`）；计数 N 按各自状态集、空则禁用；跨页完整 selected 语义保持；操作后 refresh。

- [ ] 实现（preload 的 pauseVideos/resumeVideos 第六轮已存在，确认 api 名）+ typecheck + build + 提交（`feat: 视频批量暂停/继续`）。

---

## 执行说明

- 串行派发 Task 1 → Task 2；每任务独立审查。
- Task 1 真机验收（手动测试筛选日志应显示按钮/面板命中）。
