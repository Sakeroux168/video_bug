# 抖音视频批量爬取桌面程序 - 设计文档

**日期**: 2026-07-31
**状态**: 已确认，待实现规划

## 1. 概述

### 1.1 目标

构建一个 Electron 桌面程序，内置浏览器登录抖音。用户通过筛选条件（关键词/作者/话题 + 时间范围/视频时长）搜索，批量爬取**无水印 MP4** 到本地。

### 1.2 范围

- **产品形态**: 桌面程序（Electron + React），内嵌浏览器
- **单次规模**: 大批量 200-1000 个视频
- **产出**: 仅无水印 MP4 文件，文件名 `{标题}_{作者}_{aweme_id前8}.mp4`
- **登录方式**: 内嵌浏览器扫码登录 + 持久 Cookie（`persist:douyin`）
- **抓取方案**: 页面注入 fetch/XHR 挂钩，拦截抖音内部 API JSON 回传（方案 A）
- **交付**: 先 `npm run dev` 跑通，不打包 exe

### 1.3 非目标 (YAGNI)

- 不做代理/多账号轮换
- 不做视频内容审核/AI 分析
- 不做自动定时爬取（按需手动触发）
- 不做评论/封面/元数据导出（只要视频文件）
- 不打包安装包（后续再议）

## 2. 架构与模块

三层架构，每层职责单一、可独立测试：

```
┌────────────────────────────────────────────┐
│ 渲染层 React                               │
│   ├ 标签页：管理面板 / 抖音网页             │
│   ├ 筛选表单 (类型/关键词/时间/时长/数量)   │
│   ├ 任务列表 + 进度 + 作者收藏             │
│   └ IPC 客户端 (调用主进程能力)             │
├────────────────────────────────────────────┤
│ 主进程 Electron                            │
│   ├ 任务调度器 (串行任务，内部并发下载)     │
│   ├ 数据解析器 (JSON→结构化，过滤/去重)     │
│   ├ 下载器 (并发3，带Cookie，立即下载)      │
│   ├ SQLite (任务/视频/作者)                │
│   └ WebContentsView 控制器 (注入挂钩)      │
├────────────────────────────────────────────┤
│ 内嵌浏览器 WebContentsView                 │
│   ├ 加载抖音页面 (持久 session)            │
│   └ 注入 fetch/XHR 挂钩 → JSON → postMessage│
└────────────────────────────────────────────┘
```

### 2.1 模块边界

- `main/scheduler.ts` — 任务队列，串行抓取，内部并发 3 个下载
- `main/injector.ts` — 注入到页面的挂钩脚本（fetch/XHR 拦截）
- `main/extractor.ts` — JSON → 结构化视频数据，过滤/去重
- `main/downloader.ts` — 接收 play_addr，带 Cookie 下载，文件名清洗
- `main/db.ts` — SQLite 封装（tasks/videos/authors 三表）
- `main/browser.ts` — WebContentsView 生命周期、页面导航、注入时机
- `main/ipc.ts` — IPC 桥（渲染层 ↔ 主进程）
- `renderer/` — React UI，通过 `window.api` 调主进程
- `preload/` — 页面世界 ↔ 主进程的消息桥（postMessage 监听）

### 2.2 关键设计点

1. **抓取和下载解耦**：挂钩只产数据入队，下载器独立消费，避免地址过期
2. **地址立即下载**：拿到 play_addr 立即进下载队列，2-3 分钟内消费，规避过期
3. **浏览器执行路径**：页面自算签名（X-Bogus），天然绕过签名逆向；登录态天然复用
4. **作者表**：每次抓取 upsert 作者信息 + 主页链接，为"一键爬作者主页"铺路

## 3. 核心机制：页面挂钩拿数据

### 3.1 挂钩脚本

页面 `dom-ready` 后由主进程 `executeJavaScript` 注入，包住 `window.fetch` 与 `XMLHttpRequest`：

- 请求完成后读取响应文本，若为 JSON 且 URL 匹配抖音内部接口特征（`aweme/v1/web/`、`aweme/v1/app/` 等），则解析出视频列表
- 每个视频提取：`aweme_id` / `desc`(标题) / `author.sec_uid`+`author.nickname` / `video.play_addr`(直链) / `duration`(秒) / `create_time`(Unix秒) / `statistics.digg_count`(点赞)
- 通过 `window.postMessage({ type: 'dy:videos', data: [...] })` 回传

### 3.2 消息桥

- preload 在隔离世界监听 `window` 的 `message` 事件（DOM 事件跨世界共享），收到 `dy:*` 消息后用 `ipcRenderer.send` 转发到主进程
- 主进程 `ipcMain.on('dy:videos')` 收到 → 走解析/过滤/入队

### 3.3 无水印直链

- 接口返回的 `play_addr.url_list[0]` 通常已是无水印
- 若 URL 含 `playwm`：把路径中的 `playwm` 替换为 `play` 即得无水印直链
- 兜底：URL 含 `_watermark` 时移除该片段

### 3.4 翻页

- 主进程定时让页面 `scrollTo(0, document.body.scrollHeight)`，触发下一页加载
- 每滚一次前先做去重快照，避免重复入队
- 停止条件：达到目标数量 或 连续 N 轮无新视频（视为翻完）

## 4. 数据流与抓取流程

```
用户在管理面板填筛选条件
  ↓
[1] 主进程创建任务 → 入队 SQLite (tasks.status=pending)
  ↓
[2] 调度器取出 → WebContentsView 加载对应抖音页
     ├─ 关键词：https://www.douyin.com/search/{kw}
     ├─ 作者：  https://www.douyin.com/user/{sec_uid}
     └─ 话题：  https://www.douyin.com/search/{kw} (话题标识)
  ↓
[3] 挂钩脚本持续回传视频 JSON → 解析器
     按 时间范围 + 时长 过滤，按 aweme_id 去重
     作者信息 upsert 进 authors
  ↓
[4] 滚动加载下一页，重复 [3]，直到目标数量或翻完
  ↓
[5] 命中视频入 videos(pending) → 下载器并发消费 (并发=3)
     ├─ 立即带 Cookie HTTP GET play_addr → 存盘
     ├─ 文件名 {标题}_{作者}_{aweme_id前8}.mp4
     │   (非法字符替换/超80截断/标题空兜底/重名加序号)
     ├─ 成功 → status=done, 记录 local_path
     └─ 失败 → status=failed, 记录错误码, 可重试
  ↓
[6] 全程 IPC 推进度：任务级 + 视频级 + 错误日志
```

### 4.1 关键决策点

1. **滚动间隔 1.5-3 秒随机**，模拟人工，降风控概率
2. **地址立即下载**：不等批量，下载器 2-3 分钟内消费
3. **去重**：`aweme_id` 全局唯一键，跨任务不重复下载
4. **限速**：下载并发固定 3；抓取阶段串行（同时只跑一个任务）
5. **断点续传**：任务/视频状态全落 SQLite，重启后 `running→paused` 待继续，`pending` 视频自动重试

## 5. 数据模型（SQLite）

```sql
-- 抓取任务表
tasks {
  id            INTEGER PK AUTOINCREMENT
  type          TEXT      -- 'keyword' | 'author' | 'hashtag'
  query         TEXT      -- 关键词/话题文本，或 sec_uid
  filters       TEXT JSON -- {timeRange, duration, ...}
  status        TEXT      -- 'pending'|'running'|'done'|'paused'|'failed'
  target_count  INTEGER   -- 目标抓取数（默认 200，上限 1000）
  fetched_count INTEGER   -- 实际命中数
  error         TEXT      -- 失败原因（错误码）
  created_at    TIMESTAMP
  finished_at   TIMESTAMP
}

-- 视频表（下载单元）
videos {
  id            INTEGER PK AUTOINCREMENT
  task_id       INTEGER FK → tasks.id
  aweme_id      TEXT UNIQUE  -- 抖音视频唯一ID，去重键
  title         TEXT
  author_id     INTEGER FK → authors.id
  play_addr     TEXT         -- 抓取时的无水印直链（可能过期）
  duration      INTEGER      -- 秒
  publish_time  TIMESTAMP
  stats         TEXT JSON    -- {diggCount, ...}
  status        TEXT         -- 'pending'|'downloading'|'done'|'failed'
  local_path    TEXT
  file_size     INTEGER
  error         TEXT         -- 错误分类码
  retry_count   INTEGER DEFAULT 0
  fetched_at    TIMESTAMP    -- 抓取时间（判地址过期）
  downloaded_at TIMESTAMP
  INDEX idx_status, idx_task_id, idx_aweme_id
}

-- 作者表（为"一键爬主页"铺路）
authors {
  id            INTEGER PK AUTOINCREMENT
  sec_uid       TEXT UNIQUE
  nickname      TEXT
  home_url      TEXT         -- https://www.douyin.com/user/{sec_uid}
  video_count   INTEGER      -- 累计抓到该作者视频数
  last_fetched_at TIMESTAMP
  note          TEXT
}
```

### 5.1 设计要点

1. **aweme_id 唯一键**：跨任务去重
2. **filters 存 JSON**：筛选结构可演进，只用于回显
3. **play_addr + fetched_at 配对**：下载前 `now - fetched_at > 30min` → 标 `address_expired`
4. **authors 独立表**：sec_uid 唯一，每次抓取 upsert

## 6. UI 与交互

顶部标签栏：`[管理面板] [抖音网页]`，两标签。

### 6.1 管理面板

```
┌─筛选条件───────────────────────────────────┐
│ 类型: ○关键词 ○作者 ○话题                   │
│ 输入: [________________]                    │
│ 时间: [全部 ▼]  时长: [全部 ▼]              │
│ 目标数量: [200]                             │
│                            [开始抓取]       │
├────────────────────────────────────────────┤
│ 任务列表（表格）                            │
│ 任务1 关键词"美食探店" 350/200 ██████ 完成  │
│   展开: 视频级进度 + 失败项可重试            │
├────────────────────────────────────────────┤
│ 作者收藏（卡片）                            │
│ @博主A 视频23 [爬主页]   @博主B 视频15 [爬] │
└────────────────────────────────────────────┘
```

- 时间下拉：全部 / 近7天 / 近30天 / 自定义日期区间
- 时长下拉：全部 / 短(<1分钟) / 中(1-5分钟) / 长(>5分钟)
- 任务列表支持单选/Ctrl多选/Shift范围选，批量重试或删除
- 失败任务红色高亮，hover 显示错误分类和操作建议
- 状态文案阶段化：抓取中/下载中/完成汇总

### 6.2 抖音网页标签

- 加载 douyin.com，首次手动扫码登录
- 登录态由持久 session（`persist:douyin`）保存，后续免登录
- 风控滑块/验证时切到这里手动处理

## 7. 错误处理与边界

### 7.1 错误分类矩阵

| 错误码 | 触发场景 | 处置 | 用户提示 |
|--------|---------|------|---------|
| `network` | 下载超时/连接重置 | 自动重试2次，间隔5s | "网络波动，正在重试 (1/2)..." |
| `address_expired` | `now - fetched_at > 30min` | 标失败不重试 | "视频地址已过期，需重新抓取" |
| `forbidden` | 403/滑块/连续空数据 | 暂停整个任务 | "触发风控，请到抖音网页标签手动验证后继续" + [继续任务] |
| `login_expired` | 抓取返回未登录态 | 暂停任务 | "登录已失效，请重新扫码" |
| `disk` | 写盘失败/磁盘满 | 暂停任务 | "磁盘写入失败，请检查下载目录" |
| `parse_error` | 接口结构变化 | 跳过该项，记录日志 | "部分视频解析失败，已跳过 (X个)" |

### 7.2 关键边界处理

1. **风控应对**（最大风险）：
   - 信号：连续 3 个请求返回空数据 / 403 / 重定向验证页
   - 自动暂停（`status=paused`），停止一切请求
   - 提示切抖音标签手动过验证；点"继续"从中断点恢复（基于 aweme_id 去重）

2. **地址过期防护**：下载前查 `fetched_at`；下载队列堆积 > 30 个 pending 时暂停抓取，先消化下载

3. **文件命名边界**：非法字符 `\/:*?"<>|` → `_`；超 80 截断+`...`；标题空 → `{作者}_{aweme_id}`；重名追加 `_{序号}`

4. **断点续传**：启动时扫描 `running` 任务改 `paused`；`pending` 视频自动重试

## 8. 技术栈

- **桌面框架**: Electron
- **前端**: React + TypeScript
- **数据库**: SQLite (better-sqlite3)
- **HTTP 客户端**: Node 内置 fetch / undici
- **构建工具**: electron-vite
- **UI**: Tailwind CSS（自定义，克制动效、微调圆角）
- **测试**: Vitest（extractor/过滤器/去重/文件名清洗）

## 9. 成功标准

1. 首次启动 → 抖音标签扫码登录 → 登录态持久化
2. 管理面板填筛选 → 触发抓取 → 任务列表实时进度
3. 抓取 200-1000 个视频 → 无水印 MP4 下载到指定目录，文件名带标题
4. 作者信息自动入作者表 → 可"爬主页"发起作者主页爬取
5. 风控/网络错误正确分类提示，支持断点续传和单视频重试
