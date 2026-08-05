# 需求文档：第六轮验收修复（暂停即时/筛选CDP/程序内删视频/文件管理tab）

**日期**: 2026-08-02
**状态**: 已确认（2 个澄清问题已答），待开发
**上一轮**: 第五轮验收清单全绿（窗口显示/参数保留/下载暂停都通过）

## 1. 核心诉求（4 条）

### ① 爬取暂停要即时（不再"等一会才暂停"）

- **根因**：暂停打断的是调度循环里的等待 sleep，但 `scrollToBottom` 一次注入脚本要连续跑 ~10-30 秒，期间暂停不生效。
- **修法（页面级中止信号，毫秒级生效）**：
  - 滚动脚本每步检查中止标志，置位则立即 break 返回。
  - 信号链路：主进程 `webContents.send('dy:scroll-abort')` → douyin preload（隔离世界）`ipcRenderer.on` → `window.postMessage({type:'dy:scroll-abort'})` → 主世界滚动脚本监听 `message` 置标志（脚本 finally 里移除监听防泄漏）。
  - `scheduler.pause()` 触发该信号；每次 scrollToBottom 开始前清标志。
- **验收**：任务滚动中点「暂停」，**1 秒内**停止滚动并进入暂停态；继续恢复正常。

### ② 筛选续爬没反应（下拉框只认真实鼠标悬停）

- **根因**：筛选下拉框是 CSS `:hover` 驱动，合成 `mouseover/mouseenter/mousemove` 事件不触发真实 hover 状态，面板元素不出现在 DOM，脚本后续步骤全失效。
- **修法（CDP 真实鼠标事件）**：`applyDouyinFilter` 改用 `webContents.debugger`——
  1. `attach('1.3')` → 2. executeJavaScript 取筛选按钮 `getBoundingClientRect()` → 3. `Input.dispatchMouseEvent {type:'mouseMoved', x, y}`（真实 hover）→ 4. 轮询面板 `sel.panel` 出现 → 5. 对每个配置项：取 rect → mouseMoved 悬停 → mousePressed/mouseReleased 点击 → 6. 等刷新 → detach（finally）。
  - debugger attach 失败（如已开调试控制台）→ 回退现有合成事件方案；仍失败 → 现有 notice 兜底不卡死。
- **验收**：搜索到底/15s 无新视频 → 下拉框真实打开 → 选项被选 → 页面刷新 → 继续爬新内容。

### ③ 程序内删除视频（不用去文件夹删）

- 视频表格行加「删除」+ 批量「删除选中」：
  - 主进程 `video:delete`(ids)：查 `local_path` → 若在 `downloadDir` 下且是文件 → 永久删除文件（`path.relative` 防路径穿越校验）→ 删 DB 行 → 受影响作者 `video_count` 重算（= 剩余视频数）。
  - 永久删除 + `window.confirm` 二次确认（已确认）。
  - 任何状态都能删（done 删文件+记录；collected/pending/cancelled/failed 只删记录）。
- **验收**：删一条/批量删 → 文件消失、表格行消失、任务统计更新、作者视频数同步。

### ④ 文件管理 tab（新页面，二级钻取）

- 新 tab「文件管理」：读取下载目录的品类文件夹（以磁盘为准）。
- **一级页**：品类表格（品类名｜视频数｜总大小｜删除），勾选+框选批量「删除选中品类」；点品类行进入二级页。
- **二级页**：该作者文件夹下的作者表格（作者名｜视频数｜总大小｜删除），返回按钮；同样批量。
- 删除 = 永久删除该文件夹（递归）+ DB 联动（删该路径前缀的 videos 行 + 作者 video_count 重算）；二次确认；路径穿越防护。
- 两级选择复用现有 `useTableSelection`（勾选/框选/排他语义一致）。
- **验收**：能看到品类/作者/文件；删品类/作者生效；批量框选删除生效；删除后回到一级页数据刷新。

## 2. 范围

### 做

- browser.ts / preload/douyin.ts / scheduler.ts：① 暂停即时信号链路
- browser.ts：② CDP 真实鼠标 hover/点击
- ipc.ts / db.ts / TaskList.tsx：③ 删除视频（文件+记录+计数重算）
- ipc.ts / db.ts / 新 FileManager.tsx / App.tsx：④ 文件管理 tab（扫描 + 删除 + 二级钻取 UI）

### 不做（本轮）

- 回收站删除（已确认永久删除）
- 文件管理里播放/重命名
- 打包 exe

## 3. 验收标准

- [ ] 滚动中暂停 1 秒内停止
- [ ] 筛选续爬下拉框真实打开并完成筛选
- [ ] 视频行内删除/批量删除生效（文件+记录+统计联动）
- [ ] 文件管理 tab：品类→作者二级钻取、批量框选删除、数据刷新
- [ ] `npm run typecheck` + `npx vitest run`（159 基线 + 新增）全绿 + `npm run build`

## 4. 任务拆分（决策层派单，专家岗位）

**工作流 A — 主进程**
1. Task 1（①）：暂停即时信号（调度工程师 + Electron 窗口工程师）
2. Task 2（②）：CDP 真实鼠标筛选（注入/窗口工程师）
3. Task 3（③）主进程：video:delete + 文件删除 + 计数重算（数据库工程师）
4. Task 4（④）主进程：files:tree / files:deleteCategory / files:deleteAuthor + 路径防护（归档工程师）

**工作流 B — 渲染层**
5. Task 3 UI：TaskList 行内删除/批量删除 + 确认（前端交互工程师）
6. Task 4 UI：FileManager 组件 + tab 注册（前端交互工程师）

**质量**：任务审查官逐个把关；总审查官终审。
