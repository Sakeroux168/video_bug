# 下载交互 + AI 品类整理 + 浏览器独立窗口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让抓取工具支持：浏览器独立可拖拽窗口、自动/手动两种下载方式与选择表格、下载暂停/取消/继续、按 `品类\作者\视频` 归档、AI 听语音+看图判定作者品类、去重开关放对位置。

**Architecture:** 5 个子系统，按依赖分层：DB 层（状态扩展）→ 归档/下载/浏览器/调度 → IPC/UI → ASR(本地中文转写) → AI 视觉分类。ASR 参考 `F:\123\ainame` 的 sherpa-onnx SenseVoice 方案照搬为 TS，子进程转写规避 Electron 卡死。视频先平铺下载，整理阶段按作者归位。

**Tech Stack:** Electron 35 + electron-vite 3 + React 18 + TS + node:sqlite + vitest；新增 `sherpa-onnx-node`(N-API)；复用本机 `F:/123/ffmpeg*/bin/ffmpeg.exe`。

## Global Constraints

- **TS strict**；缩进 2 空格、行尾分号，风格与现有 `src/main/*.ts` 一致。
- 逻辑模块一律**可脱离 Electron 测试**（vitest + `tests/helpers/node-sqlite.cjs` shim）；只有 Electron API（BrowserWindow）与 sherpa 子进程用人工验收。
- 测试里构造 `CreateTaskInput` 的地方（`tests/db.test.ts`、`tests/downloader.test.ts`、`tests/scheduler.test.ts`）需补 `autoDownload: true`。
- 新增运行时依赖仅 `sherpa-onnx-node`；main 构建用 `externalizeDepsPlugin`（native 依赖保持 `require`）。
- 文件树：`{downloadDir}/{品类}/{作者昵称}/{标题}_{作者}_{awemeId前8}.mp4`；品类名/目录名做 Windows 非法字符清洗（复用 `sanitizeCategory` 思路）。
- 中文 UI 文案；任务并发下载全局唯一队列（暂停/继续全局粒度，用户已确认）。
- ASR 模型钉死 `sense-voice-zh-en-ja-ko-yue-2024-07-17`（int8 + ITN 带标点），源 huggingface.co / hf-mirror.com，`tokens.txt` 与 `silero_vad.onnx` 一并下载。

---

### Task 1: DB 层扩展（类型 + schema + 迁移 + 查询）

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `CreateTaskInput.autoDownload: boolean`；`CreateTaskInput.allowDuplicateAuthor?: boolean`；`TaskRow.auto_download: number`；`VideoRow.author_nickname?: string|null`；`VideoStatus` 增 `'collected' | 'cancelled'`；`TaskStats` 增 `collected/cancelled`；`db.taskStats()` 返回扩展计数；`db.listVideos()` 联查 `author_nickname`；`db.createTask(db,input)` 写 `auto_download`。

- [ ] **Step 1: 写失败测试**（`tests/db.test.ts` 追加）
  1. `createTask` 带 `autoDownload:false` → `listTasks()[0].auto_download === 0`；缺省 DB 迁移：`initDb` 后老表（无 auto_download 列）能读且默认 1。
  2. `taskStats` 对 `collected`/`cancelled` 计数正确。
  3. `listVideos` 返回行的 `author_nickname` 等于该作者昵称。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/db.test.ts` → 失败（新列不存在 / 字段缺失）。

- [ ] **Step 3: 实现**
  - `types.ts`：按 Interfaces 增改类型。
  - `db.ts`：
    - `SCHEMA` 的 tasks 建表加 `auto_download INTEGER NOT NULL DEFAULT 1`；authors 加 `organize_state TEXT`、`ai_classified_at TEXT`；新增 `transcripts` 表（`content_hash TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', speech_sec REAL NOT NULL DEFAULT 0, total_sec REAL NOT NULL DEFAULT 0, engine TEXT, created_at TEXT`）。
    - `initDb` 迁移：`PRAGMA table_info` 判缺列后 `ALTER TABLE tasks ADD COLUMN auto_download INTEGER NOT NULL DEFAULT 1`、authors 两列同理。
    - `createTask` INSERT 加 `auto_download` 列，值 `Number(input.autoDownload ?? true)`。
    - `listVideos`：`SELECT v.*, a.nickname AS author_nickname FROM videos v LEFT JOIN authors a ON a.id=v.author_id WHERE v.task_id=?`。
    - `taskStats`：GROUP BY 里补 `collected`/`cancelled` 分支。

- [ ] **Step 4: 跑测试通过**

Run: `npx vitest run tests/db.test.ts` → 全绿（含既有 7 条）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/main/db.ts tests/db.test.ts
git commit -m "feat: db层支持 auto_download/collected/cancelled/作者昵称联查"
```

---

### Task 2: 文件树归档 Organizer（品类\作者\视频）

**Files:**
- Create: `src/main/organizer.ts`
- Modify: `src/main/db.ts`（导出 `listAuthorVideos`、`setAuthorOrganizeState` 若缺）
- Test: `tests/organizer.test.ts`

**Interfaces:**
- Produces:
  - `export function sanitizeCategory(s): string`（从 scheduler.ts 提升复用；非法字符→`_`，trim，slice(0,32)，空→`未分类`）
  - `export function authorDirName(author: {nickname;sec_uid}, db): string`（昵称清洗 + 同名不同 sec_uid 加 `_${sec_uid.slice(-6)}`）
  - `export class Organizer { constructor(deps: {db; downloadDir; resolveCategory: (author, samples)=>Promise<string|null>; onProgress?}); markAuthorPending(authorId): void; async organizeAuthor(authorId): Promise<{moved;category;state:'done'|'failed'}>; async organizePending(): Promise<number>; async organizeAll(): Promise<number> }`
  - `markAuthorPending(authorId)`：`organize_state` 为 null 或 'failed' 的作者置 'pending'（'done' 跳过），供 Scheduler 下载完成事件调用。
- Consumes: `AuthorRow`、`VideoRow`、`db`。

- [ ] **Step 1: 写失败测试**（`tests/organizer.test.ts`，用临时目录）
  1. `organizeAuthor`：作者 2 条 `done` 视频 → 移到 `{tmp}/{品类}/{昵称}/`，DB `local_path` 更新为新路径，`organize_state='done'`，返回 `{moved:2}`。
  2. 作者昵称清洗：昵称含 `/\:*` → 落盘目录不含这些字符。
  3. 同名作者（不同 sec_uid）→ 第二个目录带 `_xxxxxx` 后缀。
  4. 无 `done` 视频 / resolveCategory 返回 null → 归「未分类」，state 仍 `done`（不视为失败）。
  5. `organizePending`：只处理 `organize_state='pending'` 的作者；`organizeAll` 处理所有有 `done` 视频未归档的作者。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/organizer.test.ts` → 模块不存在。

- [ ] **Step 3: 实现** `src/main/organizer.ts`
  - 用 `fs.rename` 移动（同盘原子）；`mkdirSync(recursive)`；目标文件若已存在用 `ensureUniqueName`（复用 `src/main/filename.ts`）。
  - 归档后 `UPDATE videos SET local_path=? WHERE id=?`。
  - `resolveCategory` 注入（AI/回退逻辑在 Task 14 接线）；失败不抛、记 `organize_state='failed'`。
  - 需要时在 `db.ts` 补 `listAuthorVideos(db, authorId, status?)` 与 `setAuthorOrganizeState(db, id, state)` 查询/写。

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 提交**

```bash
git add src/main/organizer.ts src/main/db.ts tests/organizer.test.ts
git commit -m "feat: 按 品类\作者 归档 Organizer"
```

---

### Task 3: Downloader 暂停 / 继续 / 取消 / 手动下载

**Files:**
- Modify: `src/main/downloader.ts`
- Modify: `src/shared/types.ts`（无新类型，复用 `VideoStatus` 的 cancelled/collected）
- Test: `tests/downloader.test.ts`

**Interfaces:**
- Produces（`Downloader` 新方法）：
  - `pause(): void`（`drain()` 不再取新任务；在途完成）
  - `resume(): void`（清暂停并 `drain()`）
  - `isPaused(): boolean`
  - `cancel(ids: number[]): void`（在途 `AbortController.abort()` + 队列移除 + `status='cancelled'`；排队 `pending` 移除并标 `cancelled`）
  - `download(ids: number[]): void`（`collected`/`cancelled`/`failed` → `status='pending'` + `enqueue`）
- Consumes: 既有 `enqueue/onEvent/start`。

- [ ] **Step 1: 写失败测试**（`tests/downloader.test.ts` 追加）
  1. `pause()` 后 `enqueue` 不入队（fetch 不被调）；`resume()` 后执行。
  2. `cancel` 在途：fetch 收到 abort signal（fetchImpl 里记录 `signal.aborted`），状态变 `cancelled`，**不**走网络重试（`retry_count` 不增、不重新 enqueue）。
  3. `cancel` 排队项：队列中 pending → 变 `cancelled` 且不再下载。
  4. `download([collectedId])` → 状态 `pending` 并下载成功 `done`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/downloader.test.ts`

- [ ] **Step 3: 实现** `downloader.ts`
  - 加 `private paused = false`、`private aborters = new Map<number, AbortController>()`。
  - `drain()`：`while (this.active < concurrency && this.queue.length>0 && !this.paused)`。
  - `runOne`：创建 `AbortController` 存 map，`fetch(url,{signal})` + `pipeline(Readable.fromWeb(body,{signal}), ws)`；`catch` 里先判 `err.name==='AbortError'` → 标 `cancelled`、删临时文件、**return**（跳过重试）；`finally` 删 map 项。
  - `cancel`：遍历 ids，在途 abort、队列过滤移除、DB 标 `cancelled`，emit `video:status`。
  - `download`：设 `pending` + `enqueue`。

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 提交**

```bash
git add src/main/downloader.ts tests/downloader.test.ts
git commit -m "feat: 下载器 暂停/继续/取消/手动下载"
```

---

### Task 4: 浏览器改为独立可拖拽子窗口

**Files:**
- Modify: `src/main/browser.ts`
- Modify: `src/main/index.ts`（`updateBrowserDisplay`、重启恢复、`forceBrowserFull` 语义）
- Modify: `src/renderer/src/components/BrowserPanel.tsx`
- Modify: `src/renderer/src/App.tsx`（无需改逻辑，确认 tab 切换仍调 show/hide）

**Interfaces:**
- Consumes: 现有 `VideoBrowser` 公有方法不变（`init/load/scrollToBottom/setVisible/openDevTools/dispose`）。
- Produces: `VideoBrowser` 内部由 `WebContentsView` 改为 `BrowserWindow(parent: host)`；无外部签名变化。

- [ ] **Step 1: 重写 `browser.ts`**
  - `new BrowserWindow({ parent: host, width: 480, height: 760, minWidth: 320, minHeight: 480, title: '抖音浏览器', webPreferences: { partition: 'persist:douyin', preload: join(__dirname,'../preload/douyin.js'), contextIsolation: true, nodeIntegration: false } })`。
  - 保留：`setBackgroundThrottling(false)`、`will-navigate` 拦非 https、`setWindowOpenHandler` deny+外部打开、dom-ready/did-navigate/did-finish-load 三处注入。
  - `load`→`win.loadURL`；`scrollToBottom` 逻辑不变（对 `win.webContents.executeJavaScript`）；`setVisible`→`show()/hide()`（首次 show 定位主窗口右侧 `host.getBounds().x + width + 24`）；`openDevTools`→`win.webContents.openDevTools({mode:'detach'})`；`dispose`→`win.destroy()`。
  - `win.on('close', e => { if (!forceClose) { e.preventDefault(); win.hide() } })`，`forceClose` 在 dispose 时置 true。
  - 删除 `TOP_OFFSET`、`applyBounds`、`host.on('resize')`。

- [ ] **Step 2: 简化 `index.ts`**
  - `updateBrowserDisplay()`：`if (taskRunning || forceBrowserFull) browser.setVisible(true); else browser.setVisible(browserShown)`（保留，但现在是窗口 show/hide，无"盖面板"问题）。
  - 验证暂停分支：`forceBrowserFull=true` 后 `browser.setVisible(true)` + `browser.focus()`（新加 `focus()`：`win.show(); win.focus()`）。
  - 重启恢复块：额外 `UPDATE videos SET status='pending' WHERE status='downloading'`，再对 `pending` 批量 enqueue（把 downloader 拉起的 pending 与恢复的 downloading 一起入队）。

- [ ] **Step 3: 更新 `BrowserPanel.tsx`**
  文案改为「抖音浏览器已弹出为独立窗口，可自由拖动/缩放/最小化」+「打开抖音窗口」按钮（`api.showBrowser()`）+ 保留「打开调试控制台」。

- [ ] **Step 4: 人工验收（`npm run dev`）**
  - 启动出现/可打开抖音窗口；拖动、缩放、最小化正常；登录态刷新不丢。
  - 点「×」只隐藏不销毁；重新显示后页面仍登录。
  - 抓取时窗口弹出，管理面板可正常操作不被遮挡；验证暂停窗口聚焦弹出。
  - 回归：抓取能正常滚到底、采到目标数量。

- [ ] **Step 5: 提交**

```bash
git add src/main/browser.ts src/main/index.ts src/renderer/src/components/BrowserPanel.tsx
git commit -m "feat: 浏览器改为独立可拖拽子窗口"
```

---

### Task 5: Scheduler 下载方式（自动/手动）+ 重启恢复 + 整理触发

**Files:**
- Modify: `src/main/scheduler.ts`
- Modify: `src/main/index.ts`（`Scheduler` 构造注入 `organizer`、`organizeDebounceMs`；downloader 事件接线）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Produces: `SchedulerDeps` 增 `organizer?: Organizer | null`、`organizeDebounceMs?: number`。
- Consumes: `task.auto_download`；`Organizer.markPending? / organizeAuthor / organizePending`。

- [ ] **Step 1: 写失败测试**（`tests/scheduler.test.ts` 追加）
  1. 手动模式任务（`autoDownload:false`）：`handleRaw` 后视频 `status='collected'`，`FakeDownloader.enqueued` 为空。
  2. 自动模式（`autoDownload:true`）：`status='pending'` 且 `enqueued` 含该 id。
  3. 下载 done 且任务 `aiOrganizeEnabled` → 该作者被标 pending（organizer 注入 spy 记录）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`

- [ ] **Step 3: 实现** `scheduler.ts`
  - `run()` 读 `task.auto_download` 存字段；`handleRaw` 插入语句 `status` 参数化：`auto_download ? 'pending' : 'collected'`，仅 `pending` 时 `enqueue` + `pendingVideoIds.push`。
  - 删除旧 `organizeVideo`（I7 逐视频整理），改：downloader `video:status done` → `this.deps.organizer?.markAuthorPending(row.author_id)`（在 db 补 `setAuthorOrganizeState`，若作者已 `done` 跳过）；触发去抖：`clearTimeout`+`setTimeout(organizeDebounceMs)` 调 `organizer.organizePending()`。
  - 去抖计时器在 `run` 结束/`stop` 时清理；`organizer` 为空或 `!aiOrganizeEnabled` 时不调度。
  - `index.ts`：构造时传 `organizer` 与 `organizeDebounceMs: getSettings().organizeDebounceMs ?? 5000`。

- [ ] **Step 4: 跑测试通过**（既有 scheduler 测试保持绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/scheduler.ts src/main/index.ts tests/scheduler.test.ts
git commit -m "feat: 调度器支持手动下载模式+作者整理触发"
```

---

### Task 6: IPC + preload 新增通道

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces（ipcMain）：
  - `download:pause` / `download:resume` / `download:state` → `{ paused }`
  - `video:download`(ids) / `video:cancel`(ids)
  - `task:create`：读 `input.autoDownload`（写 `createTask`）、`input.allowDuplicateAuthor` 覆盖 `getSettings().allowDuplicateAuthor`
  - `task:stats` 返回已扩展计数（Task 1 已含）
  - （`authors:organize`/`organize:all`/`asr:*` 统一在 Task 14 装配 Organizer 后添加，避免引用未注入的依赖）
- Produces（preload api）：`downloadPause/downloadResume/getDownloadState/downloadVideos/cancelVideos`（organize/asr 方法在 Task 14 追加）。

- [ ] **Step 1: 实现** `ipc.ts` + `preload/index.ts`（纯接线，无独立单测；类型经 `npm run typecheck` 校验）

- [ ] **Step 2: 校验**

Run: `npm run typecheck`

- [ ] **Step 3: 提交**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat: 下载/整理 IPC 通道"
```

---

### Task 7: FilterForm 下载方式 + 作者去重开关

**Files:**
- Modify: `src/renderer/src/components/FilterForm.tsx`
- Modify: `src/main/ipc.ts`（若 Task 6 已做则无）
- Test: `tests/ipc-helper` 无；用 `npm run typecheck` + 人工验收

**Interfaces:**
- Consumes: `CreateTaskInput.autoDownload`、`allowDuplicateAuthor?`；`api.getSettings()`。
- Produces: 提交时 `onSubmit` 传入 `autoDownload` 与（type=author 时）`allowDuplicateAuthor`。

- [ ] **Step 1: 实现** `FilterForm.tsx`
  - 「下载方式」单选行：自动下载（默认）/ 手动挑选 → state `autoDownload`，提交进 `onSubmit`。
  - `type==='author'` 时显示复选框「允许重复爬取该作者主页（已爬过也继续）」→ state `allowDuplicateAuthor`；初始化 `useEffect` 里 `api.getSettings()` 取默认值。
  - 提交对象补 `autoDownload`、`allowDuplicateAuthor`。

- [ ] **Step 2: 校验 + 人工验收**
  - `npm run typecheck`。
  - `npm run dev`：选手动挑选创建任务 → 任务里视频全 `collected` 不下载；author 类型下去重复选框出现且默认随设置。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/components/FilterForm.tsx
git commit -m "feat: 筛选表单 下载方式+作者去重开关"
```

---

### Task 8: TaskList 视频表格 + 全局暂停/继续

**Files:**
- Modify: `src/renderer/src/components/TaskList.tsx`
- Modify: `src/renderer/src/components/ui.tsx`（如需表格样式）

**Interfaces:**
- Consumes: `api.getDownloadState/downloadPause/downloadResume/downloadVideos/cancelVideos`、`api.getTaskStats/listTaskVideos`。
- Produces: 无新接口（组件内部状态）。

- [ ] **Step 1: 实现** `TaskList.tsx`
  - 卡片顶部：`暂停下载 / 继续下载` 按钮（`download:state` 轮询 + `onTaskProgress` 触发刷新）。
  - 展开的视频区改表格：列 = 全选｜标题｜作者｜时长｜发布时间｜点赞｜状态｜操作（下载/取消/重试/定位/原视频）。列头点击排序（作者/时长/发布时间/点赞）、搜索框（标题/作者过滤）、每页 50 分页。`filtered` 灰显不可选。
  - 手动模式任务：`collected>0` 时显示提示条「已抓取 X 条，尚未下载」+「全部下载」；选中后「下载选中(N)」「取消选中(N)」。
  - 操作：下载→`downloadVideos([id])`；取消→`cancelVideos([id])`；重试→`retryVideos`（既有）；定位/原视频（既有）。
  - 统计行补 `collected`/`cancelled` 计数文案。
  - 用 `useMemo` 做排序/搜索/分页；注意 `videos[t.id]` 可能未加载时给空态。

- [ ] **Step 2: 人工验收（`npm run dev`）**
  - 自动任务：下载进度正常、暂停/继续生效、逐条取消 → cancelled、重试可用。
  - 手动任务：抓完显示「尚未下载」、勾选若干 → 下载选中只下这些、全部下载、排序/搜索/分页工作正常。
  - 重启后 collected/cancelled 不自动下载。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/components/TaskList.tsx src/renderer/src/components/ui.tsx
git commit -m "feat: 任务列表视频表格+全局下载控制"
```

---

### Task 9: ASR 模型清单与下载

**Files:**
- Create: `src/main/asr/models.ts`
- Test: `tests/asr-models.test.ts`

**Interfaces:**
- Produces:
  - `export interface AsrModelFile { key; rel; label; bytes; sha256; sources: string[] }`
  - `export const FILES: AsrModelFile[]`（model.int8.onnx 239233841B / tokens.txt 315894B / silero_vad.onnx 643854B，源照搬 ainame `models.js`）
  - `export function setModelsRoot(dir: string): void`（测试注入）
  - `export function modelsDir(): string`（默认 `{userData}/asr-models`）
  - `export function pathFor(key): string`、`export function status(): { dir; ready; files: Array<{key;label;path;expectBytes;actualBytes;ok}>; totalBytes }`
  - `export async function ensureModels(opts?: { signal?; onProgress? }): Promise<{ ready: boolean; downloaded: string[] }>`
- Consumes: 无（纯 fs + fetch）。

- [ ] **Step 1: 写失败测试**（`tests/asr-models.test.ts`，用临时目录 `setModelsRoot`）
  1. `status()`：空目录 → 三个文件 `ok:false`、`ready:false`；放对体积文件后 `ready:true`。
  2. `ensureModels` 体积不对 → 换源/报错不残留 `.part`。
  3. 体积正确但 sha256 不符（model 文件）→ 抛错、不 rename。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/asr-models.test.ts`

- [ ] **Step 3: 实现**（照搬 ainame `models.js` 为 TS；`ensureModels` 用 `.part` + 体积/sha256 校验 + HF/hf-mirror 双源；`setModelsRoot` 使测试可注入目录）

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 提交**

```bash
git add src/main/asr/models.ts tests/asr-models.test.ts
git commit -m "feat: ASR 模型清单与下载"
```

---

### Task 10: ASR ffmpeg 封装（抽音轨/抽帧）

**Files:**
- Create: `src/main/asr/media.ts`
- Test: `tests/asr-media.test.ts`

**Interfaces:**
- Produces:
  - `export function findFfmpeg(): string | null`（复用 downloader `findFfprobe` 的目录扫描 + `where` 兜底，找 `ffmpeg.exe`）
  - `export async function extractAudio(ffmpeg: string, src: string, dest: string, opts?: { maxSec?: number }): Promise<void>`（`-vn -ac 1 -ar 16000 -c:a pcm_s16le`，`-t maxSec`；`.part` 原子写）
  - `export async function extractFrames(ffmpeg: string, src: string, destDir: string, opts?: { count?: number; height?: number }): Promise<string[]>`（均匀抽帧，避开首尾 5%，单帧失败不中断整批，返回成功帧路径数组）
- Consumes: `child_process.execFile`。

- [ ] **Step 1: 写失败测试**（`tests/asr-media.test.ts`；若本机 ffmpeg 存在则用真实 ffmpeg 对一段生成的小视频抽 2 帧/抽音轨，校验产物存在；无 ffmpeg 环境跳过）
  1. `extractAudio` 产出 wav 文件（>0 字节）。
  2. `extractFrames(count:3)` 产出 3 张 jpg（存在且>0 字节）。

- [ ] **Step 2: 跑测试确认失败**（模块不存在）

- [ ] **Step 3: 实现** `media.ts`（atomicOutput + 轻量并发闸门；参数校验）

- [ ] **Step 4: 跑测试通过**（本机有 `F:/123/ffmpeg*/bin/ffmpeg.exe`，应过）

- [ ] **Step 5: 提交**

```bash
git add src/main/asr/media.ts tests/asr-media.test.ts
git commit -m "feat: ASR ffmpeg 抽音轨/抽帧封装"
```

---

### Task 11: ASR 转写子进程（sherpa worker）+ 构建配置

**Files:**
- Create: `src/main/asr/asr-worker.ts`
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Produces: worker 脚本，读 `process.argv[2]` 请求 JSON 文件 `{ wav, model, tokens, vad, numThreads, provider }`，stdout 打一行 JSON `{ text, totalSec, speechSec, segments, whole, provider, providerFellBack }`；错误第一行可读、`process.exitCode=1`（不 `process.exit`）。
- Consumes: `sherpa-onnx-node`（require）。

- [ ] **Step 1: 写 `asr-worker.ts`**（照搬 ainame `worker.js` 为 TS：SenseVoice + `useInverseTextNormalization:1`、silero VAD 切段算语音时长、`enableExternalBuffer=false`、短于 30s 整段喂、`provider` 失败回落 CPU；避免 TS 与 native 类型的摩擦，内部用 `any` 收敛，**文件顶部标注"与 ainame worker.js 对齐"**）

- [ ] **Step 2: 改 `electron.vite.config.ts`**：main `build.rollupOptions.input` 加 `'asr-worker': resolve('src/main/asr/asr-worker.ts')`。

- [ ] **Step 3: 校验**
  - `npm run build`：`out/main/asr-worker.js` 生成。
  - 人工：`out/main/asr-worker.js` 无参数运行 → 打印可读用法错误、退出码 1。

- [ ] **Step 4: 提交**

```bash
git add src/main/asr/asr-worker.ts electron.vite.config.ts
git commit -m "feat: sherpa 转写子进程+构建入口"
```

---

### Task 12: ASR 转写编排（缓存 + judge + 子进程拉起）

**Files:**
- Create: `src/main/asr/asr.ts`
- Test: `tests/asr.test.ts`

**Interfaces:**
- Produces:
  - `export function meaningfulChars(text): number`（去空白与标点后字数）
  - `export function judge(input: { text; speechSec; totalSec }): { chars; density; likelySpeech; reason }`（MIN_CHARS=10、MIN_CHARS_PER_SEC=0.5，纯 BGM 判定，照搬 ainame `judge`）
  - `export interface Transcript { text: string; speechSec: number; totalSec: number; likelySpeech: boolean; fromCache: boolean }`
  - `export async function transcribeFor(db, row: { aweme_id; local_path }, opts: { ffmpeg: string; models: { model; tokens; vad }; maxSec?: number; signal? }): Promise<Transcript>`
- Consumes: `db`（transcripts 表）、`extractAudio`、worker 子进程、`findFfmpeg`。

- [ ] **Step 1: 写失败测试**（`tests/asr.test.ts`；worker 用 mock 子进程拉起的封装注入，或对 `judge`/`meaningfulChars` 纯函数直接测）
  1. `meaningfulChars('你好，世界！abc.')` = 5。
  2. `judge`：正常文本 → `likelySpeech:true`；只有背景声（稀疏文本，低密度）→ `likelySpeech:false` 带原因；过短 → false。
  3. `transcribeFor` 缓存：同 `aweme_id` 二次调用 → `fromCache:true`、不重复拉 worker；DB transcripts 落一条。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/asr.test.ts`

- [ ] **Step 3: 实现** `asr.ts`
  - `transcribeFor`：查 transcripts 缓存（key=`aweme_id`）→ miss 则 `extractAudio` → 写请求 JSON 文件（避免命令行中文/空格转义）→ `execFile(process.execPath, [join(__dirname,'asr-worker.js'), reqFile], { env: { ELECTRON_RUN_AS_NODE: '1' }, timeoutMs })` → 解析 stdout 末行 JSON → `judge` → 写缓存 → 删临时 wav/req。

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 提交**

```bash
git add src/main/asr/asr.ts tests/asr.test.ts
git commit -m "feat: ASR 转写编排（缓存+judge+子进程）"
```

---

### Task 13: Analyzer 视觉扩展 + 作者分类

**Files:**
- Modify: `src/main/analyzer.ts`
- Create: `src/main/ai/organizer-ai.ts`
- Test: `tests/analyzer.test.ts`、`tests/organizer-ai.test.ts`

**Interfaces:**
- Produces:
  - `Analyzer.classifyWithMedia(text: string, images: Array<{ dataUrl: string }>, cacheKey: string): Promise<{ category: string; tags: string[] }>`（content = 文本 + image_url parts；**不**带 `response_format`；60s 超时；解析 JSON）
  - `organizer-ai.ts`：
    - `export interface ClassifyDeps { analyzer: Analyzer | null; asr: { transcribeFor: (row)=>Promise<Transcript> } | null; ffmpeg: string | null; framesCount?: number; samplesCount?: number }`
    - `export async function classifyAuthor(author: AuthorRow, samples: VideoRow[], deps: ClassifyDeps): Promise<string | null>`（成功返回品类，失败/无法判定返回 null；策略：转写每样本→标注有无语音→拼 prompt（作者名+标题+转写+帧图）→ `classifyWithMedia`；全部无语音或视觉失败 → 仍尝试；无 analyzer/asr/ffmpeg → 直接 null）
- Consumes: `extractAudio`/`extractFrames`/`transcribeFor`/`judge`（Task 10/12）。

- [ ] **Step 1: 写失败测试**
  - `analyzer.test.ts`：`classifyWithMedia` 用 mock fetch 断言请求体含 `image_url` content 且无 `response_format`，返回品类解析正确。
  - `organizer-ai.test.ts`：mock analyzer（返回品类）、mock asr（一条样本有语音一条无）、mock ffmpeg（抽帧返回假路径）→ `classifyAuthor` 返回品类且 prompt 含无语音标注；analyzer 抛错 → 返回 null。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（`classifyWithMedia` 在 `chat` 基础上扩展；`organizer-ai.ts` 编排样本→ASR→抽帧→prompt→AI；帧 base64 上限约 8MB 提前拦）

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 提交**

```bash
git add src/main/analyzer.ts src/main/ai/organizer-ai.ts tests/analyzer.test.ts tests/organizer-ai.test.ts
git commit -m "feat: AI 视觉分类+按作者品类判定"
```

---

### Task 14: Organizer 集成（触发 + 状态流转 + 设置面板）

**Files:**
- Modify: `src/main/index.ts`（组装 Organizer + resolveCategory 接线 + 手动 IPC）
- Modify: `src/main/ipc.ts`（`authors:organize`/`organize:all` 已含，若 Task 6 未做则补）
- Modify: `src/renderer/src/components/SettingsPanel.tsx`（ASR 模型状态+下载、整理全部）
- Modify: `src/renderer/src/components/AuthorCollection.tsx`（每行「整理」按钮 + 点击反馈）
- Modify: `src/main/settings.ts`（`organizeDebounceMs` 默认 5000；可选 `asrMaxSec` 默认 90）

**Interfaces:**
- Produces: `index.ts` 组装 `resolveCategory = async (author, samples) => { if (analyzer && asrReady) { const c = await classifyAuthor(...); if (c) return c } return author.category ?? null }`；`Organizer` 实例注入 Scheduler 与 IPC。
- Consumes: Task 2/5/9/12/13 全部。

- [ ] **Step 1: 接线 `index.ts`**：构造 `Organizer`（`resolveCategory` 用 Task 13 `classifyAuthor` + 作者已有 `category` 回退）；Scheduler 构造传 organizer + debounce；`settings:save` 后重建（asr 模型状态影响 resolveCategory 分支）。

- [ ] **Step 2: 补 IPC + preload**
  - `authors:organize`(authorId) / `organize:all` → 调 `Organizer`；返回 `{ moved, category }` 或错误。
  - `asr:status` → `models.status()`；`asr:download` → `ensureModels`（onProgress 透传给渲染层）。
  - preload 加 `organizeAuthor/organizeAll/getAsrStatus/downloadAsrModels`。

- [ ] **Step 3: 设置面板**
  - 「运行参数」加：语音模型状态行（`asr:status` → 三文件体积/就绪）+「下载模型」按钮（进度条）。
  - 加「整理全部」按钮（调 `organize:all`）+ 结果 toast。

- [ ] **Step 4: 作者表格**：每行加「整理」按钮（`organizeAuthor(id)` + `notify`）。

- [ ] **Step 5: 校验 + 人工验收**
  - `npm run typecheck`；全量 `npx vitest run` 保持绿。
  - `npm run dev`：下载语音模型 → 建任务开启 AI 整理 → 下载完成后作者自动归档到 `{下载目录}\{品类}\{作者昵称}\`；纯 BGM 视频的作者也能靠画面出品类；作者表「整理」与设置「整理全部」可用。
  - 模型未下载/未配置 AI → 整理仍能按作者已有品类归档，否则「未分类」。

- [ ] **Step 6: 提交**

```bash
git add src/main/index.ts src/main/ipc.ts src/main/settings.ts src/preload/index.ts src/renderer/src/components/SettingsPanel.tsx src/renderer/src/components/AuthorCollection.tsx
git commit -m "feat: AI整理集成+设置面板模型下载"
```

---

## 执行顺序说明

- **Task 1–8** 是"下载交互 + 浏览器窗口 + 去重开关 + 文件树归档（不依赖 AI）"，可独立交付。
- **Task 9–14** 是"AI 听+看品类判定"，依赖本地 ffmpeg（本机已有）与 sherpa 模型（运行时下载）。
- Task 5 依赖 Task 2（Organizer 类型），Task 14 汇总接线。Task 3/4/9/10 相互独立，可并行实施。

## 验收汇总

1. `npm run typecheck` 通过。
2. `npx vitest run` 全绿（既有 69 + 新增）。
3. `npm run dev` 人工走查：浏览器独立窗口可拖；手动挑选/自动下载/暂停/取消/继续/重试生效；重启不自动下载 collected/cancelled；下载后归档 `品类\作者\`；AI 分类对中文语音转写正确、纯 BGM 走视觉兜底。
