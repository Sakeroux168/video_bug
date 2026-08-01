# 多平台视频批量爬取桌面程序 - 设计文档

**日期**: 2026-07-31
**状态**: 已确认，待实现规划

## 1. 概述

### 1.1 目标

构建一个 Electron 桌面程序，内置浏览器登录视频平台。用户通过筛选条件（关键词/作者/话题 + 时间范围/视频时长）搜索，批量爬取**无水印 MP4** 到本地，并可选 **AI 分析**（下载前筛选 + 下载后整理）。

### 1.2 范围

- **产品形态**: 桌面程序（Electron + React），内嵌浏览器
- **首发平台**: 抖音（douyin.com）
- **单次规模**: 大批量，目标数量由用户在 **200-1000** 之间自定义（默认 200，上限 1000）
- **产出**: 仅无水印 MP4 文件，文件名 `{标题}_{作者}_{aweme_id前8}.mp4`；可选 AI 打标签 + 按分类归档
- **登录方式**: 内嵌浏览器扫码登录 + 持久 Cookie（`persist:{platform}`）
- **抓取方案**: 页面注入 fetch/XHR 挂钩，拦截平台内部 API JSON 回传（方案 A）
- **AI 分析**: 云端 API（OpenAI 兼容接口，可配地址/Key/模型），只分析文本元数据
- **扩展性**: 平台适配器架构，抖音为首发适配器，为快手/小红书/TikTok/B站 预留
- **交付**: 先 `npm run dev` 跑通，不打包 exe

### 1.3 非目标 (YAGNI)

- 不做代理/多账号轮换
- 不做自动定时爬取（按需手动触发）
- 不做评论/封面导出（只要视频文件）
- **不做音视频内容理解**（听语音/看画面识别内容）；AI 只分析标题+文案等文本元数据
- 不打包安装包（后续再议）

## 2. 架构与模块

三层 + 平台适配层，职责单一、可独立测试：

```
┌────────────────────────────────────────────────┐
│ 渲染层 React                                   │
│   ├ 标签页：管理面板 / 内置浏览器 / 设置        │
│   ├ 筛选表单 (平台/类型/关键词/时间/时长/数量)  │
│   ├ AI 开关 (先审后下 / 下载后整理)             │
│   ├ 任务列表 + 进度 + 作者收藏                  │
│   └ IPC 客户端                                 │
├────────────────────────────────────────────────┤
│ 主进程 Electron                                │
│   ├ 任务调度器 (串行任务，内部并发下载)         │
│   ├ 平台适配器层 (PlatformAdapter 接口)         │
│   │   ├ douyin 适配器 (首发)                   │
│   │   └ kuaishou/xiaohongshu/tiktok/bilibili   │
│   │     （预留，后续逐个实现）                  │
│   ├ 数据解析器 (适配器输出 → 过滤/去重)         │
│   ├ AI 分析器 (OpenAI 兼容客户端)               │
│   ├ 下载器 (并发3，带Cookie，立即下载)          │
│   ├ SQLite (任务/视频/作者，带 platform)        │
│   └ WebContentsView 控制器 (注入通用挂钩)       │
├────────────────────────────────────────────────┤
│ 内嵌浏览器 WebContentsView                     │
│   ├ 加载平台页面 (持久 session)                │
│   └ 注入通用 fetch/XHR 挂钩 → JSON → postMessage│
└────────────────────────────────────────────────┘
```

### 2.1 模块边界

- `main/adapters/types.ts` — `PlatformAdapter` 接口定义
- `main/adapters/douyin.ts` — 抖音适配器（首发）
- `main/adapters/index.ts` — 适配器注册表（按平台名取用）
- `main/scheduler.ts` — 任务队列，串行抓取，内部并发 3 个下载
- `main/injector.ts` — 注入到页面的通用挂钩脚本（fetch/XHR 拦截，平台 URL 规则由适配器提供）
- `main/extractor.ts` — 适配器输出的原始 JSON → 统一结构化视频数据，过滤/去重
- `main/analyzer.ts` — OpenAI 兼容客户端：先审后下 / 下载后分类打标签
- `main/downloader.ts` — 接收 play_addr，带 Cookie 下载，文件名清洗
- `main/db.ts` — SQLite 封装（tasks/videos/authors 三表，含 platform）
- `main/browser.ts` — WebContentsView 生命周期、页面导航、注入时机
- `main/ipc.ts` — IPC 桥（渲染层 ↔ 主进程）
- `renderer/` — React UI，通过 `window.api` 调主进程
- `preload/` — 页面世界 ↔ 主进程的消息桥（postMessage 监听）

### 2.2 关键设计点

1. **抓取和下载解耦**：挂钩只产数据入队，下载器独立消费，避免地址过期
2. **地址立即下载**：拿到 play_addr 立即进下载队列，2-3 分钟内消费
3. **浏览器执行路径**：页面自算签名（如抖音 X-Bogus），天然绕过签名逆向；登录态天然复用
4. **平台无关核心**：调度/下载/存储/AI 全部只认统一数据模型，平台差异封在适配器里
5. **作者表**：每次抓取 upsert 作者信息 + 主页链接，为"一键爬作者主页"铺路

## 3. 核心机制：页面挂钩拿数据

### 3.1 通用挂钩脚本

页面 `dom-ready` 后由主进程 `executeJavaScript` 注入，包住 `window.fetch` 与 `XMLHttpRequest`：

- 请求完成后读取响应文本，若为 JSON 且 URL 匹配**当前适配器提供的接口特征**（如抖音 `aweme/v1/web/`），把原始 JSON 整段通过 `window.postMessage({ type: 'dy:raw', url, data })` 回传
- **通用原则**：脚本只做拦截转发，不解析任何平台规则；解析全部交给主进程的适配器

### 3.2 消息桥

- preload 在隔离世界监听 `window` 的 `message` 事件（DOM 事件跨世界共享），收到 `dy:*` 消息后用 `ipcRenderer.send` 转发到主进程
- 主进程 `ipcMain.on('dy:raw')` 收到 → 按当前任务适配器解析

### 3.3 适配器解析

每个平台适配器实现统一解析：原始 JSON → 视频项列表：

- `aweme_id`(唯一ID) / `title`(desc) / `author`(sec_uid+昵称+主页链接) / `play_addr`(无水印直链) / `duration`(秒) / `publish_time`(Unix秒) / `likes`(点赞)

### 3.4 无水印直链（抖音）

- 接口返回的 `play_addr.url_list[0]` 通常已是无水印
- 若 URL 含 `playwm`：路径中 `playwm` → `play`
- URL 含 `_watermark` 时移除该片段
- 其他平台的无水印处理封装在各平台适配器内

### 3.5 翻页

- 主进程定时让页面 `scrollTo(0, document.body.scrollHeight)`，触发下一页
- 每滚一次前先做去重快照，避免重复入队
- 停止条件：达到目标数量 或 连续 N 轮无新视频

## 4. 数据流与抓取流程

```
用户在管理面板填筛选条件 + AI 开关
  ↓
[1] 主进程创建任务 → 入队 SQLite (tasks.status=pending, platform=抖音)
  ↓
[2] 调度器取出 → WebContentsView 加载对应平台页面
     抖音：关键词→/search/{kw}  作者→/user/{sec_uid}  话题→/search/{kw}
     其他平台 URL 由各自适配器构造
  ↓
[3] 通用挂钩回传原始 JSON → 当前适配器解析 → 统一视频项
     按 时间范围 + 时长 过滤，按 aweme_id 去重
     作者信息 upsert 进 authors
  ↓
[4] （可选·先审后下）AI 按用户筛选规则判断留/弃
     弃 → 标 filtered 跳过；留 → 继续
  ↓
[5] 滚动加载下一页，重复 [3]，直到目标数量或翻完
  ↓
[6] 命中视频入 videos(pending) → 下载器并发消费 (并发=3)
     ├─ 立即带 Cookie HTTP GET play_addr → 存盘
     ├─ 文件名 {标题}_{作者}_{aweme_id前8}.mp4
     ├─ 成功 → status=done；失败 → 错误码，可重试
  ↓
[7] （可选·下载后整理）AI 分类打标签
     → 文件移入 {输出目录}/{分类}/，DB 记标签
  ↓
[8] 全程 IPC 推进度：任务级 + 视频级 + 错误日志
```

### 4.1 关键决策点

1. **滚动间隔 1.5-3 秒随机**，模拟人工，降风控概率
2. **地址立即下载**：不等批量，下载器 2-3 分钟内消费
3. **去重**：`(platform, aweme_id)` 联合唯一键，跨任务不重复下载
4. **限速**：下载并发固定 3；抓取阶段串行；AI 请求并发限 2
5. **断点续传**：状态全落 SQLite，重启后 `running→paused` 待继续，`pending` 视频自动重试

## 5. 数据模型（SQLite）

```sql
-- 抓取任务表
tasks {
  id            INTEGER PK AUTOINCREMENT
  platform      TEXT DEFAULT 'douyin'  -- 平台
  type          TEXT      -- 'keyword' | 'author' | 'hashtag'
  query         TEXT      -- 关键词/话题文本，或 sec_uid
  filters       TEXT JSON -- {timeRange, duration, aiFilter, ...}
  status        TEXT      -- 'pending'|'running'|'done'|'paused'|'failed'
  target_count  INTEGER   -- 目标抓取数，用户自定义 200-1000（默认 200）
  fetched_count INTEGER   -- 实际命中数
  error         TEXT      -- 失败原因（错误码）
  created_at    TIMESTAMP
  finished_at   TIMESTAMP
}

-- 视频表（下载单元）
videos {
  id            INTEGER PK AUTOINCREMENT
  platform      TEXT DEFAULT 'douyin'
  task_id       INTEGER FK → tasks.id
  aweme_id      TEXT        -- 平台视频唯一ID
  title         TEXT
  author_id     INTEGER FK → authors.id
  play_addr     TEXT        -- 无水印直链（可能过期）
  duration      INTEGER     -- 秒
  publish_time  TIMESTAMP
  stats         TEXT JSON   -- {likes, ...}
  ai_verdict    TEXT        -- AI 判定: 'pass'|'filtered'|null（未审）
  ai_tags       TEXT JSON   -- AI 分类+标签 {category, tags[]}
  status        TEXT        -- 'pending'|'downloading'|'done'|'failed'
  local_path    TEXT
  file_size     INTEGER
  error         TEXT        -- 错误分类码
  retry_count   INTEGER DEFAULT 0
  fetched_at    TIMESTAMP
  downloaded_at TIMESTAMP
  UNIQUE(platform, aweme_id)
  INDEX idx_status, idx_task_id, idx_aweme_id
}

-- 作者表
authors {
  id            INTEGER PK AUTOINCREMENT
  platform      TEXT DEFAULT 'douyin'
  sec_uid       TEXT
  nickname      TEXT
  home_url      TEXT
  video_count   INTEGER
  last_fetched_at TIMESTAMP
  note          TEXT
  UNIQUE(platform, sec_uid)
}
```

### 5.1 设计要点

1. **`(platform, aweme_id)` 联合唯一键**：跨平台、跨任务去重
2. **filters 存 JSON**：筛选结构可演进，只用于回显
3. **play_addr + fetched_at 配对**：下载前 `now - fetched_at > 30min` → 标 `address_expired`
4. **ai_verdict / ai_tags 冗余在 videos 表**：避免 AI 结果重算、支持"只要已过审的"查询

## 6. UI 与交互

顶部标签栏：`[管理面板] [内置浏览器] [设置]`，三标签。

### 6.1 管理面板

```
┌─筛选条件─────────────────────────────────────┐
│ 平台: [抖音 ▼]   类型: ○关键词 ○作者 ○话题    │
│ 输入: [________________]                     │
│ 时间: [全部 ▼]  时长: [全部 ▼]               │
│ 目标数量: [200]  (200-1000 可自定义)          │
│ AI: ☑先审后下  ☐下载后整理                    │
│ AI筛选规则: [只要美食教程，不要游戏直播]       │
│                              [开始抓取]       │
├──────────────────────────────────────────────┤
│ 任务列表（表格）                              │
│ 任务1 抖音/关键词"美食探店" 350/200 ████ 完成 │
│   展开: 视频级进度 + AI判定 + 失败项可重试     │
├──────────────────────────────────────────────┤
│ 作者收藏（卡片）                              │
│ @博主A 视频23 [爬主页]   @博主B 视频15 [爬]   │
└──────────────────────────────────────────────┘
```

- 时间下拉：全部 / 近7天 / 近30天 / 自定义日期区间
- 时长下拉：全部 / 短(<1分钟) / 中(1-5分钟) / 长(>5分钟)
- **目标数量**：数字输入框，**200-1000 之间可自定义**（默认 200），越界即时校验
- **AI 开关**：先审后下 / 下载后整理，互不依赖；AI 未配置 Key 时开关置灰并引导去设置
- 任务列表支持单选/Ctrl多选/Shift范围选，批量重试或删除
- 失败任务红色高亮，hover 显示错误分类和操作建议

### 6.2 内置浏览器标签

- 加载当前平台站点（抖音 douyin.com），首次手动扫码登录
- 登录态由持久 session（`persist:{platform}`）保存，后续免登录
- 风控滑块/验证时切到这里手动处理

### 6.3 设置标签

- **下载目录**：默认 `~/Downloads/爬取视频`，可改
- **AI 配置**：API 地址（默认 OpenAI 兼容格式）/ API Key / 模型名；"测试连接"按钮
- **运行参数**：下载并发（默认3，1-5 可选）、滚动间隔、地址过期阈值

## 7. 错误处理与边界

### 7.1 错误分类矩阵

| 错误码 | 触发场景 | 处置 | 用户提示 |
|--------|---------|------|---------|
| `network` | 下载超时/连接重置 | 自动重试2次，间隔5s | "网络波动，正在重试 (1/2)..." |
| `address_expired` | `now - fetched_at > 30min` | 标失败不重试 | "视频地址已过期，需重新抓取" |
| `forbidden` | 403/滑块/连续空数据 | 暂停整个任务 | "触发风控，请到内置浏览器手动验证后继续" + [继续任务] |
| `login_expired` | 抓取返回未登录态 | 暂停任务 | "登录已失效，请重新扫码" |
| `disk` | 写盘失败/磁盘满 | 暂停任务 | "磁盘写入失败，请检查下载目录" |
| `parse_error` | 接口结构变化 | 跳过该项，记录日志 | "部分视频解析失败，已跳过 (X个)" |
| `ai_auth` | AI Key 无效/未配置 | 暂停 AI，降级为纯下载 | "AI 配置无效，已关闭 AI 分析，请到设置检查" |
| `ai_quota` | AI 额度不足/限流 | 暂停 AI，降级为纯下载 | "AI 额度不足，已关闭 AI 分析" |
| `ai_timeout` | AI 请求超时 | 该项标失败可重试 | "AI 分析超时，该项将重试" |

### 7.2 关键边界处理

1. **风控应对**（最大风险）：
   - 信号：连续 3 个请求返回空数据 / 403 / 重定向验证页
   - 自动暂停（`status=paused`），停止一切请求
   - 提示切内置浏览器标签手动过验证；点"继续"从中断点恢复（基于联合唯一键去重）

2. **AI 降级**：任何 AI 故障都不影响纯下载流程——AI 失败只暂停 AI 环节，不暂停抓取/下载

3. **地址过期防护**：下载前查 `fetched_at`；下载队列堆积 > 30 个 pending 时暂停抓取，先消化下载

4. **文件命名边界**：非法字符 `\/:*?"<>|` → `_`；超 80 截断+`...`；标题空 → `{作者}_{aweme_id}`；重名追加 `_{序号}`

5. **断点续传**：启动时扫描 `running` 任务改 `paused`；`pending` 视频自动重试

## 8. 技术栈

- **桌面框架**: Electron
- **前端**: React + TypeScript
- **数据库**: SQLite（Node 内置 `node:sqlite` 的 `DatabaseSync`；Electron 主进程经 `NODE_OPTIONS=--experimental-sqlite` 启用。注：因本机 VS2026 无法编译 better-sqlite3 原生模块，改用内置模块，2026-08-01 确认）
- **HTTP 客户端**: Node 内置 fetch / undici
- **AI 客户端**: OpenAI 兼容 REST 接口（自实现轻量客户端，或 `openai` SDK），baseURL/Key/模型可配
- **构建工具**: electron-vite
- **UI**: Tailwind CSS（自定义，克制动效、微调圆角）
- **测试**: Vitest（extractor/适配器/过滤器/去重/文件名清洗）

## 9. 成功标准

1. 首次启动 → 内置浏览器扫码登录 → 登录态持久化
2. 管理面板填筛选（含平台/时间/时长/数量 200-1000）→ 触发抓取 → 任务列表实时进度
3. 抓取 200-1000 个视频 → 无水印 MP4 下载到指定目录，文件名带标题
4. AI：先审后下能按规则过滤；下载后整理能分类归档 + 打标签
5. 作者信息自动入作者表 → 可"爬主页"发起作者主页爬取
6. 风控/网络/AI 错误正确分类提示，支持断点续传和单视频重试
7. 架构上有适配器接口 + 注册表，新增平台不碰核心代码

## 10. AI 分析（云端 API）

### 10.1 两个环节

1. **先审后下**（下载前筛选）：
   - 抓到视频元数据（标题+文案+作者+时长）→ 拼接成文本 → 发给 AI
   - Prompt 内含用户填写的**筛选规则**（自然语言，例："只要美食教程，不要游戏直播"）
   - AI 返回 `{ pass: bool, reason }` → pass 入下载队列，否则标 `filtered` 跳过
2. **下载后整理**：
   - 下载完成后，用同样文本再发一次 → AI 返回 `{ category, tags[] }`
   - 文件移入 `{输出目录}/{分类}/`，标签写入 DB `ai_tags`

### 10.2 成本控制

- 只发文本元数据，绝不发送音视频内容（v1 边界）
- 结果按 `(platform, aweme_id)` 缓存，重复任务不重复花钱
- AI 请求并发限 2；每任务可设"最多审多少个"上限
- 两个开关独立，全关则纯下载，不产生任何 AI 费用

### 10.3 配置与降级

- 设置页填 API 地址 / Key / 模型；"测试连接"按钮验证
- 兼容任意 OpenAI 格式服务（Claude/通义/DeepSeek/本地 Ollama 的兼容端点等）
- 任何 AI 错误按 §7.1 矩阵降级，不影响纯下载

## 11. 平台适配器架构

### 11.1 PlatformAdapter 接口

```ts
interface PlatformAdapter {
  name: string                    // 'douyin' | 'kuaishou' | ...
  hostPatterns: RegExp[]          // 挂钩脚本需要拦截的域名
  apiUrlPatterns: RegExp[]        // 内部接口 URL 特征（如 /aweme/v1/web/）
  sessionPartition: string        // 'persist:douyin' 等，登录态隔离
  // URL 构造
  buildSearchUrl(query, filters): string
  buildAuthorUrl(secUid): string
  buildHashtagUrl(query): string
  // 解析
  parseApiJson(url, json): VideoItem[]
  // 无水印处理
  normalizePlayUrl(rawUrl): string
}
```

### 11.2 注册表

- `adapters/index.ts`：`{ douyin: DouyinAdapter, kuaishou?: ..., }` 按平台名取用
- 新增平台 = 新写一个适配器文件 + 注册一行，核心模块零改动
- 挂勾脚本、调度器、下载器、数据库、AI、UI 全部只认 `PlatformAdapter`

### 11.3 预留平台

快手 / 小红书 / TikTok / B站 后续逐个实现（每个平台只需：登录 URL、接口特征、JSON 解析、无水印规则）。当前只实现并验证抖音。

### 11.4 UI 联动

- 管理面板平台下拉 → 动态换当前适配器 → 输入框语义、登录标签、无水印规则跟着走
- 平台列表来自适配器注册表，新增平台 UI 自动出现
