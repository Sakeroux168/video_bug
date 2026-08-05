# 第七轮验收修复 实施计划（时长解析/筛选诊断/文件管理定位+总大小）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** ①时长列显示真实时长（多候选解析 + 0 时长日志）；②筛选续爬加全链路日志 + 手动测试按钮（诊断先行）；③文件管理定位按钮；④文件管理总大小。

**Architecture:** 三个任务串行派发、逐个审查。需求文档 `docs/requirements-2026-08-02g.md`。

## Global Constraints

- TS strict；2 空格/分号/中文注释；逻辑模块可脱离 Electron 测试。
- 回归底线：`npm run typecheck` + `npx vitest run`（206 基线 + 新增）全绿 + `npm run build`。
- 定位用 `shell.showItemInFolder`，路径过 `isPathInside` 校验（复用 Task 3/4 轮已抽的路径工具）。
- 筛选日志走现有 rawLog 面板或同款机制，不新增重型设施。

---

### Task 1（①）: 时长多候选解析 + 0 时长日志

**Files:** `src/main/adapters/douyin.ts`、`src/main/index.ts`（rawLog 调试日志）、`tests/douyin-adapter.test.ts`

**Interfaces:** Produces: `parseAweme` 时长多候选 `Number(o.duration ?? (o.video ? asObj(o.video).duration : undefined) ?? 0)`（毫秒→秒）；解析结果 0 时经既有 dy:raw 日志通道输出条目顶层字段名提示（rawLog 条目附 `durationZero: true` 或类似，渲染层「查看拦截日志」可见）。

- [ ] 失败测试：video.duration 候选（顶层无 duration）→ durationSec 正确；顶层 duration → 不变。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`fix: 时长多候选解析+0时长日志`）。

### Task 2（②）: 筛选续爬全链路日志 + 手动测试按钮

**Files:** `src/main/scheduler.ts`（触发决策日志）、`src/main/browser.ts`（CDP 各步骤日志）、`src/main/index.ts`（日志收集/转发）、`src/main/ipc.ts`（`debug:testFilter` 通道）、`src/preload/index.ts`、`src/renderer/src/App.tsx`（「手动测试筛选」按钮 + 日志面板展示）、`tests/scheduler.test.ts`（触发决策日志断言可选）

**Interfaces:** Produces:
- 日志：scheduler 触发决策每一步 emit 到日志（停滞判定/到底文案命中/15s 计时/filterApplied 状态）；browser 的 CDP 步骤（attach 成败、按钮坐标、面板轮询结果、每选项点击结果）输出；统一汇入现有 rawLog 面板（扩展行内容或新增 `filterLog` 字段）。
- `debug:testFilter`（无参）：取当前 running/paused 任务里最近一个启用 douyinFilter 的 keyword 任务，手动执行一次筛选流程（复用 scheduler 的触发逻辑或直接调 browser.applyDouyinFilter），结果/日志进面板；无可用任务时返回提示。
- App 头部（或日志面板旁）加「手动测试筛选」按钮。

- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 筛选续爬全链路日志+手动测试按钮`）。

### Task 3（③④）: 文件管理定位 + 总大小

**Files:** `src/main/ipc.ts`、`src/main/fileManager.ts`、`src/preload/index.ts`、`src/renderer/src/components/FileManager.tsx`、`tests/file-manager.test.ts`

**Interfaces:** Produces: `files:locate`(dirPath) → isPathInside 校验 → `shell.showItemInFolder`；`files:tree` 返回加 `totalSize`（所有文件合计）或前端累加；UI：一级/二级每行「定位」按钮、顶部「总大小 X」（GB/MB 自适应，复用 MB 格式化扩展）。

- [ ] 失败测试：totalSize 累加正确；locate 路径校验拒绝逃逸。
- [ ] 实现 + 全绿 + typecheck + build + 提交（`feat: 文件管理定位+总大小`）。

---

## 执行说明

- 串行派发 Task 1 → Task 2 → Task 3；每任务独立审查。
- Task 2 的日志要能支撑用户实跑后反馈定位（输出要含关键状态值）。
