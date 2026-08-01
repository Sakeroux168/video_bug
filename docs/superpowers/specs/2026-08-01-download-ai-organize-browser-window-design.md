# 下载交互 + AI 品类整理 + 浏览器独立窗口 — 设计

> 日期：2026-08-01
> 状态：已与用户确认，待写实施计划

## Context

用户实测后提交 `F:\123\爬取标题遇到的问题.txt`，共 3 个问题：

1. **爬取时回不去管理面板**：内置浏览器是叠在主窗口上的 `WebContentsView`，抓取时全屏盖住整个面板。
2. **下载交互需重设计**：现在"爬一条下载一条"自动流，无选择、无暂停/取消；要"自动下载 / 手动挑选"两种方式，界面清晰、支持取消/暂停/继续。
3. **去重开关找不到**：`allowDuplicateAuthor` 只在设置页，创建任务时看不到。

头脑风暴中用户补充了 3 点：

4. 文件树改为 **`下载目录\品类\作者\视频.mp4`**（按作者归类）。
5. AI 品类判定升级：**听语音（中文转写）+ 看图**判断作者属于哪一品类；参考 `F:\123\ainame` 的现成实现。
6. 浏览器不再强制全屏，改为**独立可拖拽窗口**（挡住面板就拖走）。

## 现状（关键代码）

- 浏览器：`src/main/browser.ts` `VideoBrowser` 用 `WebContentsView` + `setBounds` 叠在主窗口上；`src/main/index.ts` `updateBrowserDisplay()` 在 `taskRunning || forceBrowserFull` 时强制可见 → 盖面板。`setBackgroundThrottling(false)` 已保证隐藏/后台不节流。
- 下载：`src/main/downloader.ts` 全局队列 + 并发 + 网络重试；下载即写入 `{downloadDir}/{标题}_{作者}_{id}.mp4`（平铺）。`src/main/scheduler.ts` `handleRaw` 抓到即 `enqueue`。
- AI：`src/main/analyzer.ts` 只做**文本元数据**判定（`judgeFilter` 先审后下 / `classify` 下载后整理），无音频/视觉。
- 现有 ffmpeg：`F:/123/ffmpeg*/bin/ffprobe.exe` 已用于黑屏校验，`ffmpeg.exe` 同在（`findFfprobe` 同目录逻辑）。
- 参考项目 `F:\123\ainame`：sherpa-onnx-node（SenseVoice 中文转写 + silero VAD）、ffmpeg 抽帧/抽音轨、多模态分类，全套逻辑可直接照搬为 TS。

## 设计

### 1. 浏览器 → 独立可拖拽子窗口

**文件**：`src/main/browser.ts`、`src/main/index.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/components/BrowserPanel.tsx`

- `VideoBrowser` 内部从 `WebContentsView` 改为 `BrowserWindow`（`parent: host`，带标题栏，可拖动/缩放/最小化）。保留全部现有行为：
  - `webPreferences: { partition: 'persist:douyin', preload: douyin.js, contextIsolation: true, nodeIntegration: false }`。
  - `setBackgroundThrottling(false)`；`will-navigate` 拦非 https；`setWindowOpenHandler` 拦新窗口；dom-ready / did-navigate / did-finish-load 三处注入。
  - `load()` → `win.loadURL()`；`scrollToBottom()` → 对 `win.webContents.executeJavaScript`（不变）。
- `setVisible(v)` → `win.show() / win.hide()`。窗口关闭拦截为隐藏（`e.preventDefault(); hide()`），不销毁——登录态与页面缓存不丢。
- 首次显示定位：主窗口右侧（`host.getBounds().x + width + 24`），默认尺寸约 `480×760`。
- `updateBrowserDisplay()` 简化为：`if (taskRunning || forceBrowserFull) browser.setVisible(true); else browser.setVisible(browserShown)`。不再需要全屏 bounds / TOP_OFFSET。验证暂停时 `forceBrowserFull` 只做 `show() + focus()`，不再有"全屏"概念。
- 「内置浏览器」tab 仍负责显示/隐藏窗口；`BrowserPanel` 内容改成说明 + 「打开抖音窗口」按钮 + 调试按钮。App.tsx tab 切换逻辑不变。

### 2. 文件树：`下载目录\品类\作者\视频.mp4`

**文件**：`src/main/downloader.ts`、`src/main/organizer.ts`（新）、`src/main/scheduler.ts`

- 下载仍平铺写 `{downloadDir}/{文件名}.mp4`（品类未知时无从归位）。
- 新增 `Organizer`（主进程模块）负责"按作者归档"：
  - 输入：作者（`sec_uid`、`nickname`、`category`）+ 该作者 `local_path` 已存在且 `status='done'` 的视频。
  - 目标目录 `{downloadDir}/{品类}/{作者昵称}/`；作者昵称冲突（不同 sec_uid 同名）加 `_{sec_uid前4}` 后缀。
  - `rename` 后更新 `videos.local_path`；品类名复用 `sanitizeCategory`（非法字符替换、限长 32、空回落「未分类」）。
- 触发（统一在 §3 末"整理触发"一节描述）：下载完成事件去抖 + 作者表「整理」按钮 + 设置「整理全部」。任务 `aiOrganizeEnabled` 或作者已有 `category` 时执行；都无则归「未分类」。

### 3. AI 品类判定：听语音 + 看图（按作者）

**文件（新增）**：
- `src/main/asr/models.ts` — 模型清单与下载（照搬 ainame `models.js`：FILES、status、ensureModels、HF/hf-mirror 双源、sha256 校验）。
- `src/main/asr/asr.ts` — `transcribeFor(video, opts)`：缓存 → ffmpeg 抽音轨（16kHz mono wav，`-t` 前 60–90s）→ 拉起子进程转写 → `judge()` 判定有无语音。
- `src/main/asr/asr-worker.ts` — sherpa 转写子进程（照搬 ainame `worker.js`：SenseVoice + ITN=1 带标点、silero VAD 切段算语音时长、`enableExternalBuffer=false`）。作为 electron-vite main 的第二个 rollup 入口打包。
- `src/main/asr/media.ts` — ffmpeg 抽音轨 / 抽帧封装（TS 版 ainame `media.js` 的子集：`extractAudio`、`extractFrames`，带并发闸门与原子写）。
- `src/main/ai/organizer-ai.ts` — 按作者分类：取样本 → 转写 + 抽帧 base64 → 调多模态 → 输出品类。

**数据流（一次作者分类）**：
1. 取该作者至多 3 条已下载样本（`local_path` 存在的 `done` 视频）。
2. 每条样本：`extractAudio`（`-t 90`，取前 90 秒）→ `transcribe`（子进程）→ 文本 + `speechSec`/`totalSec`；`extractFrames(4)` → base64 data URLs。
3. `judge()`：字数密度低于阈值 → 该样本标记"无语音（纯背景声）"，转写文本仍保留但标注。
4. prompt（系统 + 用户）：作者昵称、每条样本的标题 + 转写文本（标注有无语音）+ 帧图 → 输出 `{ "category": "品类名" }`。
5. 成功 → 写 `authors.category`，标记已整理；失败/无语音但看图能判 → 继续用图；AI 全挂 → 保留原品类或「未分类」，标记失败供重试。
6. 返回品类 → 触发 §2 归档。

**整理触发**：
- 自动：任务开启 `aiOrganizeEnabled` 时，下载完成事件后**去抖 5 秒**；无新完成事件且 `downloader.isIdle()` → 处理该任务涉及、且尚未整理的作者（逐作者分类+归档，串行，避免 ffmpeg/AI 并发打满）。
- 手动：作者表每行「整理」按钮（单作者立即跑）；设置页「整理全部」（扫所有有 `done` 视频但未归档的作者）。
- 状态：`authors` 表加 `organize_state`（`null`=未整理 / `pending`=待整理 / `done` / `failed`），`ai_classified_at` 时间戳；分类失败保留 `failed` 供手动重试。
- 归档条件：AI 分类成功 → 用 AI 品类；AI 未配置/失败 → 用作者已有 `category`；都没有 → 「未分类」。

**缓存**：转写按内容 hash 落库（新增 `transcripts` 表：`content_hash/text/speech_sec/total_sec`），改名/移动不重转。AI 分类结果按 `authorId+model+promptVersion` 缓存（`authors.ai_classified_at` / 单独表）。

**模型管理**：
- 模型文件：`model.int8.onnx`(239MB)、`tokens.txt`、`silero_vad.onnx`(640KB)，存 `{userData}/asr-models/`。
- 设置页「运行参数」加：语音模型状态 + 「下载模型」按钮（进度条）；下载中断支持续（`.part` + 体积/sha256 校验）。
- 新增依赖：`sherpa-onnx-node`（N-API，electron-vite `externalizeDepsPlugin` 外部化，子进程 `require` 自 node_modules 解析）。

### 4. 下载交互：自动/手动 + 表格选择 + 暂停/取消/继续

**数据模型**（`src/shared/types.ts`、`src/main/db.ts`）：
- `tasks` 表加 `auto_download INTEGER NOT NULL DEFAULT 1`（1=自动 0=手动）；老库迁移 `ALTER TABLE`。
- `VideoStatus` 加 `'collected'`（手动模式抓完未下载）与 `'cancelled'`（用户取消，可重新勾选下载）。
- `TaskStats` 补 `collected`、`cancelled` 计数。
- `listVideos` `LEFT JOIN authors` 带出 `author_nickname`；`VideoRow` 加可选 `author_nickname`。
- 新增 `transcripts` 表（§3 用）。

**调度**（`src/main/scheduler.ts`）：
- 插入视频时按任务 `auto_download`：自动 → `status='pending'` + 立即 `enqueue`（现状）；手动 → `status='collected'`，不 `enqueue`。
- `handleRaw` 的"下载堆积放慢"只对自动模式生效。
- 重启恢复：只重排队 `status='pending'`；`collected`/`cancelled` 不动；顺带把遗留 `downloading` 复位为 `pending` 重排（防崩溃卡死）。

**下载器**（`src/main/downloader.ts`）：
- `pause()` / `resume()`：暂停后 `drain()` 不再取新任务，在途完成；恢复即续。状态可查询（`isPaused`）。
- `cancel(ids)`：对 `downloading` 用 `AbortController` 掐断（fetch `signal` + `Readable.fromWeb(stream,{signal})`），标 `'cancelled'`；对排队中的 `pending` 直接从队列移除并标 `'cancelled'`。**取消不触发网络重试**（AbortError 单独分支，不走 `classifyDownloadError` 的重试路径）。`collected` 项不在下载队列，取消即界面反选，无需改状态。
- `download(ids)`：把 `collected`/`cancelled`/`failed` 的视频设 `pending` 并入队。
- 每个任务一个 `AbortController`（Map<id, AbortController>），完成后清理。

**IPC / preload**（`src/main/ipc.ts`、`src/preload/index.ts`）：
- `download:pause`、`download:resume`、`download:state`（返回 `{ paused }`）
- `video:download`(ids)、`video:cancel`(ids)
- `task:create` 接收 `autoDownload`、`allowDuplicateAuthor`
- `task:stats` 返回扩展后的计数

**界面**：
- `FilterForm`：加「下载方式」单选（自动下载 / 手动挑选）；「类型=作者」时显示去重复选框（默认取设置值，可单次覆盖）。
- `TaskList`（就地展开）：
  - 卡片顶部：**全局暂停下载 / 继续下载**（状态来自 `download:state`）。
  - 展开的视频表格：列 = 全选｜标题｜作者｜时长｜发布时间｜点赞｜状态｜操作（下载/取消/重试/定位/原视频）。列头可点排序（作者/时长/时间/点赞）+ 搜索框（标题/作者）+ 每页 50 分页。`filtered` 灰色不可选。
  - 手动模式任务抓完显示提示条「已抓取 X 条，尚未下载」+「全部下载」；勾选后「下载选中(N)」「取消选中(N)」。
  - 任务统计行补 `collected`/`cancelled` 计数。

### 5. 去重开关

- `FilterForm`（type=author）显示「允许重复爬取该作者主页」复选框，`CreateTaskInput` 加 `allowDuplicateAuthor?: boolean`；`task:create` 用它覆盖 `getSettings().allowDuplicateAuthor`（未传时用设置默认）。
- 设置页 `SettingsPanel` 的全局开关保留。

## 新增依赖与外部资源

- `sherpa-onnx-node` ^1.13（N-API，win32-x64 预编译）。
- 语音模型（运行时下载，~240MB）：SenseVoice int8、tokens、silero VAD，源 = huggingface.co / hf-mirror.com（参照 ainame `models.js` 清单与校验）。
- ffmpeg：复用现有 `F:/123/ffmpeg*/bin/ffmpeg.exe`（`findFfprobe` 扩展出 `findFfmpeg`）。

## 需要改动的文件一览

- 修改：`browser.ts`、`index.ts`、`ipc.ts`、`downloader.ts`、`scheduler.ts`、`db.ts`、`analyzer.ts`、`settings.ts`、`types.ts`、`preload/index.ts`、`FilterForm.tsx`、`TaskList.tsx`、`SettingsPanel.tsx`、`BrowserPanel.tsx`、`App.tsx`、`electron.vite.config.ts`、`package.json`
- 新增：`src/main/organizer.ts`、`src/main/asr/models.ts`、`src/main/asr/asr.ts`、`src/main/asr/asr-worker.ts`、`src/main/asr/media.ts`、`src/main/ai/organizer-ai.ts`

## 测试

- **单元（vitest + 现有 node:sqlite shim）**：
  - db：`auto_download` 迁移、`taskStats` 扩展、`listVideos` join、`transcripts` 表。
  - downloader：`pause`/`resume`（暂停后不取新任务、在途完成、恢复续跑）、`cancel`（在途 AbortError → `cancelled` 不重试；排队移除）、`download` 重新入队。
  - scheduler：手动模式插入 `collected` 不 enqueue、自动模式 `pending` + enqueue。
  - asr：`judge()` 字数密度判定（有人说话 / 纯 BGM / 过短）、`models.status()` 体积校验。
  - organizer：路径 `{品类}/{作者}`、作者重名后缀、品类名清洗、`local_path` 更新。
- **手动验收（`npm run dev`）**：
  - 浏览器独立窗口可拖动/缩放/最小化；抓取时切管理面板不被遮挡；验证时窗口弹出聚焦。
  - 手动挑选任务：抓完视频在 `collected`，勾选下载/全部下载/取消/暂停/继续生效，重启后 `collected` 不自动下载。
  - 下载完成后自动归档到 `下载目录\品类\作者\`，作者表「整理」按钮可用。
  - 下载模型后跑一次作者分类：中文转写正确、纯 BGM 样本正确走视觉兜底。
  - 筛选表单 author 类型下去重复选框生效。
