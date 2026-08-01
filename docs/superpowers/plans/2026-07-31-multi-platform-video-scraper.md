# 多平台视频批量爬取桌面程序 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Electron 桌面程序：内嵌浏览器登录抖音，按筛选条件批量爬取无水印 MP4 到本地，可选云端 AI 做下载前筛选与下载后分类，平台逻辑以适配器隔离便于扩展。

**Architecture:** 三层 + 平台适配层。渲染层 React（三标签：管理面板/内置浏览器/设置）通过 IPC 调主进程；主进程含调度器、适配器注册表、解析器、AI 分析器、下载器、SQLite；内置浏览器 WebContentsView 注入通用 fetch/XHR 挂钩，把平台内部接口的原始 JSON 经 preload 消息桥回传主进程解析。

**Tech Stack:** Electron 35 / React 18 + TypeScript / electron-vite / node:sqlite（内置 SQLite）/ Tailwind CSS / Vitest

## Global Constraints

- 平台只实现抖音（`douyin`），其余平台仅留 `PlatformAdapter` 接口
- 目标数量默认 200，范围 200-1000，越界必须即时校验
- 下载并发固定 3（设置页 1-5 可调）；AI 并发 2；滚动间隔 1.5-3s 随机
- 无水印：接口直链优先；含 `playwm` 换成 `play`；含 `_watermark` 移除
- 文件命名 `{标题}_{作者}_{aweme_id前8}.mp4`，非法字符 `\/:*?"<>|` 替换为 `_`，超 80 截断，空标题兜底
- 所有任务/视频状态落 SQLite，重启后 `running→paused`、`pending` 视频自动重试
- 错误一律用分类码字符串（`network`/`address_expired`/`forbidden`/`login_expired`/`disk`/`parse_error`/`ai_auth`/`ai_quota`/`ai_timeout`）
- AI 只分析文本元数据；任何 AI 故障降级为纯下载，不中断抓取/下载
- 开发期 `npm run dev` 运行，不打包 exe
- 数据库用 Node 内置 `node:sqlite`（`DatabaseSync`），Electron 主进程需 `NODE_OPTIONS=--experimental-sqlite`（已写入 dev/start 脚本）；**不用任何原生 SQLite 模块**

---

### Task 1: 工程脚手架

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `postcss.config.js` / `tailwind.config.js`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/preload/index.d.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/index.css`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `window.api.ping(): string`（验证 IPC 通路的占位方法）；`npm run dev` 可开窗

- [ ] **Step 1: 写 package.json 与依赖清单**

```json
{
  "name": "video-scraper",
  "version": "0.1.0",
  "description": "多平台视频批量爬取工具",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "cross-env NODE_OPTIONS=--experimental-sqlite electron-vite dev",
    "build": "electron-vite build",
    "start": "cross-env NODE_OPTIONS=--experimental-sqlite electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "cross-env": "^7.0.3",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "electron": "^35.0.0",
    "electron-vite": "^3.0.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `cd "F:/123/爬取视频" && npm install`
Expected: 安装成功。无原生编译（better-sqlite3 已弃用，改用 Node 内置 node:sqlite；Electron 二进制需镜像 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，若下载失败设置后重装）。

- [ ] **Step 3: 写 electron-vite 与 tsconfig 配置**

`electron.vite.config.ts`:
```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@': resolve('src/renderer/src') } }
  }
})
```

`tsconfig.json`:
```json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true, "target": "ES2022", "module": "ESNext",
    "moduleResolution": "Bundler", "strict": true, "skipLibCheck": true,
    "esModuleInterop": true, "types": ["node"], "noEmit": true
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "electron.vite.config.ts"]
}
```

`tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "composite": true, "target": "ES2022", "module": "ESNext",
    "moduleResolution": "Bundler", "jsx": "react-jsx", "strict": true,
    "skipLibCheck": true, "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } })
```

- [ ] **Step 4: 写最小可运行的三进程文件**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200, height: 800, title: '视频爬取工具',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  ping: (): string => ipcRenderer.sendSync('api:ping') as string
})
```

`src/main/index.ts` 中追加（在 createWindow 前）：
```ts
import { ipcMain } from 'electron'
ipcMain.on('api:ping', (e) => { e.returnValue = 'pong' })
```

`src/preload/index.d.ts`:
```ts
export {}
declare global {
  interface Window { api: { ping(): string } }
}
```

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>视频爬取工具</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
```

`src/renderer/src/App.tsx`:
```tsx
export default function App(): JSX.Element {
  return <div className="flex h-screen items-center justify-center text-lg">视频爬取工具</div>
}
```

`src/renderer/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
module.exports = { content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'], theme: { extend: {} }, plugins: [] }
```

`postcss.config.js`:
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`.gitignore` 追加：
```
out/
dist/
```

- [ ] **Step 5: 跑起来验证窗口**

Run: `npm run dev`
Expected: 打开 1200x800 窗口，显示"视频爬取工具"，标题栏正常，无控制台报错。

- [ ] **Step 6: 提交**

```bash
git add . && git commit -m "chore: electron+react+ts 工程脚手架"
```

---

### Task 2: 共享类型与适配器接口

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/main/adapters/types.ts`

**Interfaces:**
- Produces: `Filters`, `CreateTaskInput`, `TaskRow`, `VideoRow`, `AuthorRow`, `AppSettings`, `ERROR`（共享给后续所有任务）；`PlatformAdapter`, `VideoItem`（适配器契约）

- [ ] **Step 1: 写共享类型**

`src/shared/types.ts`:
```ts
export type TaskType = 'keyword' | 'author' | 'hashtag'
export type TaskStatus = 'pending' | 'running' | 'done' | 'paused' | 'failed'
export type VideoStatus = 'pending' | 'downloading' | 'done' | 'failed'
export type TimeRange = 'all' | '7d' | '30d' | 'custom'
export type DurationFilter = 'all' | 'short' | 'medium' | 'long'

export interface Filters {
  timeRange: TimeRange
  startDate?: string // ISO date，timeRange='custom' 时必填
  endDate?: string
  duration: DurationFilter
  targetCount: number
  aiFilterRule?: string
}

export interface CreateTaskInput {
  platform: string
  type: TaskType
  query: string
  filters: Filters
  aiFilterEnabled: boolean
  aiOrganizeEnabled: boolean
}

export interface TaskRow {
  id: number; platform: string; type: TaskType; query: string
  filters: string; status: TaskStatus; target_count: number; fetched_count: number
  error: string | null; created_at: string; finished_at: string | null
}

export interface VideoRow {
  id: number; platform: string; task_id: number; aweme_id: string; title: string
  author_id: number | null; play_addr: string | null; duration: number
  publish_time: string | null; stats: string; ai_verdict: 'pass' | 'filtered' | null
  ai_tags: string | null; status: VideoStatus; local_path: string | null
  file_size: number | null; error: string | null; retry_count: number
  fetched_at: string; downloaded_at: string | null
}

export interface AuthorRow {
  id: number; platform: string; sec_uid: string; nickname: string
  home_url: string | null; video_count: number; last_fetched_at: string | null; note: string | null
}

export interface AppSettings {
  downloadDir: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  downloadConcurrency: number
  scrollIntervalMs: number
  addressTtlMin: number
}

export const ERROR = {
  NETWORK: 'network', ADDRESS_EXPIRED: 'address_expired', FORBIDDEN: 'forbidden',
  LOGIN_EXPIRED: 'login_expired', DISK: 'disk', PARSE_ERROR: 'parse_error',
  AI_AUTH: 'ai_auth', AI_QUOTA: 'ai_quota', AI_TIMEOUT: 'ai_timeout'
} as const
```

- [ ] **Step 2: 写适配器契约**

`src/main/adapters/types.ts`:
```ts
import type { Filters } from '../../shared/types'

/** 统一视频项：各平台原始 JSON 解析后的归一结构 */
export interface VideoItem {
  awemeId: string
  title: string
  authorSecUid: string
  authorNickname: string
  authorHomeUrl: string
  playUrl: string
  durationSec: number
  publishTime: number // unix 秒
  likes: number
}

/** 平台适配器契约：核心模块只认这个接口，平台差异全部封在里面 */
export interface PlatformAdapter {
  name: string
  displayName: string
  /** 登录态分区，如 'persist:douyin' */
  sessionPartition: string
  /** 挂钩脚本需要转发的接口 URL 特征 */
  apiUrlPatterns: RegExp[]
  buildSearchUrl(query: string, filters: Filters): string
  buildAuthorUrl(secUid: string): string
  buildHashtagUrl(query: string): string
  parseApiJson(url: string, json: unknown): VideoItem[]
  normalizePlayUrl(rawUrl: string): string
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 两个 tsconfig 均通过，无错误。

- [ ] **Step 4: 提交**

```bash
git add src/shared src/main/adapters && git commit -m "feat: 共享类型与平台适配器接口"
```

---

### Task 3: 抖音适配器（TDD）

**Files:**
- Create: `src/main/adapters/douyin.ts`
- Test: `tests/douyin-adapter.test.ts`

**Interfaces:**
- Consumes: `PlatformAdapter`, `VideoItem`（Task 2）
- Produces: `douyinAdapter: PlatformAdapter`；`collectAwemeList(json: unknown): unknown[]`（深扫找 `aweme_list`）

- [ ] **Step 1: 写失败测试**

`tests/douyin-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { douyinAdapter, collectAwemeList } from '../src/main/adapters/douyin'

const AWEME = {
  aweme_id: '7300000000000000001',
  desc: '美食探店 第3期',
  author: { sec_uid: 'MS4wLjABAAAA1', nickname: '探店小王' },
  video: { play_addr: { url_list: ['https://v.douyin.com/xxx/playwm/?foo=bar'] } },
  duration: 45000, // ms
  create_time: 1710000000,
  statistics: { digg_count: 1234 }
}

describe('douyinAdapter.parseApiJson', () => {
  it('解析搜索接口结构（data[].aweme_list）', () => {
    const json = { status_code: 0, data: [{ aweme_list: [AWEME] }] }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/search/item/', json)
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      awemeId: '7300000000000000001', title: '美食探店 第3期',
      authorSecUid: 'MS4wLjABAAAA1', authorNickname: '探店小王',
      authorHomeUrl: 'https://www.douyin.com/user/MS4wLjABAAAA1',
      playUrl: 'https://v.douyin.com/xxx/play/?foo=bar',
      durationSec: 45, publishTime: 1710000000, likes: 1234
    })
  })

  it('解析作者主页接口结构（顶层 aweme_list）', () => {
    const json = { aweme_list: [AWEME], has_more: 0 }
    const items = douyinAdapter.parseApiJson('https://www.douyin.com/aweme/v1/web/aweme/post/', json)
    expect(items).toHaveLength(1)
  })

  it('过滤掉无播放地址/无 id 的脏数据', () => {
    const items = douyinAdapter.parseApiJson('https://x/', { aweme_list: [AWEME, { aweme_id: '', desc: 'x' }] })
    expect(items).toHaveLength(1)
  })
})

describe('collectAwemeList', () => {
  it('深度扫描任意嵌套中的 aweme_list 数组', () => {
    const json = { a: { b: { aweme_list: [AWEME] } } }
    expect(collectAwemeList(json)).toHaveLength(1)
  })
})

describe('douyinAdapter.normalizePlayUrl', () => {
  it('playwm 替换为 play', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/playwm/1')).toBe('https://a/play/1')
  })
  it('移除 _watermark 片段', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/x_watermark_100')).toBe('https://a/x100')
  })
  it('已是无水印则原样返回', () => {
    expect(douyinAdapter.normalizePlayUrl('https://a/play/1')).toBe('https://a/play/1')
  })
})

describe('douyinAdapter URL 构造', () => {
  it('buildSearchUrl 编码关键词', () => {
    expect(douyinAdapter.buildSearchUrl('美食 探店', { timeRange: 'all', duration: 'all', targetCount: 200 }))
      .toBe('https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F%20%E6%8E%A2%E5%BA%97')
  })
  it('buildAuthorUrl 拼接 sec_uid', () => {
    expect(douyinAdapter.buildAuthorUrl('SEC123')).toBe('https://www.douyin.com/user/SEC123')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/douyin-adapter.test.ts`
Expected: FAIL（`douyinAdapter` 不存在）

- [ ] **Step 3: 实现适配器**

`src/main/adapters/douyin.ts`:
```ts
import type { Filters } from '../../shared/types'
import type { PlatformAdapter, VideoItem } from './types'

/** 深度优先收集所有 aweme_list 数组（搜索/主页/话题响应结构各不相同） */
export function collectAwemeList(json: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'aweme_list' && Array.isArray(val)) out.push(...val)
        else walk(val)
      }
    }
  }
  walk(json)
  return out
}

function asObj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' ? (v as Record<string, any>) : {}
}

function parseAweme(a: unknown): VideoItem | null {
  const o = asObj(a)
  const id = String(o.aweme_id ?? '')
  const author = asObj(o.author)
  const secUid = String(author.sec_uid ?? '')
  const nickname = String(author.nickname ?? '')
  const video = asObj(o.video)
  const play = asObj(video.play_addr)
  const playRaw = Array.isArray(play.url_list) && play.url_list.length > 0 ? String(play.url_list[0]) : ''
  const stats = asObj(o.statistics)
  if (!id || !playRaw) return null
  return {
    awemeId: id,
    title: String(o.desc ?? ''),
    authorSecUid: secUid,
    authorNickname: nickname,
    authorHomeUrl: secUid ? `https://www.douyin.com/user/${secUid}` : '',
    playUrl: normalizePlayUrl(playRaw),
    durationSec: Math.round(Number(o.duration ?? 0) / 1000),
    publishTime: Number(o.create_time ?? 0),
    likes: Number(stats.digg_count ?? 0)
  }
}

export function normalizePlayUrl(raw: string): string {
  let url = raw
  if (url.includes('playwm')) url = url.replace('playwm', 'play')
  if (url.includes('_watermark')) url = url.replace('_watermark', '')
  return url
}

export const douyinAdapter: PlatformAdapter = {
  name: 'douyin',
  displayName: '抖音',
  sessionPartition: 'persist:douyin',
  apiUrlPatterns: [/aweme\/v1\/web\//, /aweme\/v1\/app\//],
  buildSearchUrl: (q: string) => `https://www.douyin.com/search/${encodeURIComponent(q)}`,
  buildAuthorUrl: (secUid: string) => `https://www.douyin.com/user/${secUid}`,
  buildHashtagUrl: (q: string) => `https://www.douyin.com/search/%23${encodeURIComponent(q)}`,
  parseApiJson: (_url: string, json: unknown) =>
    collectAwemeList(json).map(parseAweme).filter((x): x is VideoItem => x !== null),
  normalizePlayUrl
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/douyin-adapter.test.ts`
Expected: PASS（6 组断言全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/adapters/douyin.ts tests/douyin-adapter.test.ts && git commit -m "feat: 抖音适配器（TDD）"
```

---

### Task 4: 解析器：过滤/去重（TDD）

**Files:**
- Create: `src/main/extractor.ts`
- Test: `tests/extractor.test.ts`

**Interfaces:**
- Consumes: `VideoItem`（Task 2）, `Filters`（Task 2）
- Produces: `matchTimeRange(tsSec, range, start?, end?, now): boolean`；`matchDuration(durSec, d): boolean`；`filterVideos(items, filters, now): VideoItem[]`；`dedupeVideos(items, seen: Set<string>): VideoItem[]`

- [ ] **Step 1: 写失败测试**

`tests/extractor.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { filterVideos, matchTimeRange, matchDuration, dedupeVideos } from '../src/main/extractor'
import type { VideoItem } from '../src/main/adapters/types'
import type { Filters } from '../src/shared/types'

const NOW = 1720000000 // 基准时间
const day = 86400
const item = (over: Partial<VideoItem>): VideoItem => ({
  awemeId: '1', title: 't', authorSecUid: 's', authorNickname: 'n', authorHomeUrl: 'h',
  playUrl: 'p', durationSec: 120, publishTime: NOW, likes: 0, ...over
})

const baseFilters: Filters = { timeRange: 'all', duration: 'all', targetCount: 200 }

describe('matchTimeRange', () => {
  it('all 恒真', () => expect(matchTimeRange(0, 'all', undefined, undefined, NOW)).toBe(true))
  it('7d 只留近7天', () => {
    expect(matchTimeRange(NOW - 3 * day, '7d', undefined, undefined, NOW)).toBe(true)
    expect(matchTimeRange(NOW - 10 * day, '7d', undefined, undefined, NOW)).toBe(false)
  })
  it('custom 用起止日期', () => {
    const start = '2024-01-01', end = '2024-12-31'
    const inRange = new Date('2024-06-01T00:00:00Z').getTime() / 1000
    const outRange = new Date('2025-06-01T00:00:00Z').getTime() / 1000
    expect(matchTimeRange(inRange, 'custom', start, end, NOW)).toBe(true)
    expect(matchTimeRange(outRange, 'custom', start, end, NOW)).toBe(false)
  })
})

describe('matchDuration', () => {
  it('短 <60s', () => { expect(matchDuration(30, 'short')).toBe(true); expect(matchDuration(90, 'short')).toBe(false) })
  it('中 60-300s', () => { expect(matchDuration(120, 'medium')).toBe(true); expect(matchDuration(30, 'medium')).toBe(false) })
  it('长 >300s', () => { expect(matchDuration(600, 'long')).toBe(true); expect(matchDuration(120, 'long')).toBe(false) })
})

describe('filterVideos', () => {
  it('时间+时长联合过滤', () => {
    const filters: Filters = { ...baseFilters, timeRange: '7d', duration: 'short' }
    const items = [item({ durationSec: 30, publishTime: NOW - day }), item({ durationSec: 500, publishTime: NOW - day })]
    expect(filterVideos(items, filters, NOW)).toHaveLength(1)
  })
})

describe('dedupeVideos', () => {
  it('按 awemeId 去重且不重复消耗 seen', () => {
    const seen = new Set(['a'])
    const items = [item({ awemeId: 'a' }), item({ awemeId: 'b' }), item({ awemeId: 'c' })]
    const out = dedupeVideos(items, seen)
    expect(out.map(i => i.awemeId)).toEqual(['b', 'c'])
    expect(seen.has('c')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/extractor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/extractor.ts`:
```ts
import type { VideoItem } from './adapters/types'
import type { Filters, DurationFilter, TimeRange } from '../shared/types'

export function matchTimeRange(tsSec: number, range: TimeRange, start?: string, end?: string, now: number = Date.now() / 1000): boolean {
  if (range === 'all') return true
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30
    return tsSec >= now - days * 86400
  }
  if (range === 'custom' && start && end) {
    const s = new Date(start + 'T00:00:00Z').getTime() / 1000
    const e = new Date(end + 'T23:59:59Z').getTime() / 1000
    return tsSec >= s && tsSec <= e
  }
  return true
}

export function matchDuration(durSec: number, d: DurationFilter): boolean {
  if (d === 'all') return true
  if (d === 'short') return durSec < 60
  if (d === 'medium') return durSec >= 60 && durSec <= 300
  return durSec > 300
}

export function filterVideos(items: VideoItem[], filters: Filters, now: number = Date.now() / 1000): VideoItem[] {
  return items.filter(i =>
    matchTimeRange(i.publishTime, filters.timeRange, filters.startDate, filters.endDate, now) &&
    matchDuration(i.durationSec, filters.duration)
  )
}

export function dedupeVideos(items: VideoItem[], seen: Set<string>): VideoItem[] {
  const out: VideoItem[] = []
  for (const it of items) {
    if (seen.has(it.awemeId)) continue
    seen.add(it.awemeId)
    out.push(it)
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/extractor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/extractor.ts tests/extractor.test.ts && git commit -m "feat: 解析器过滤/去重（TDD）"
```

---

### Task 5: 文件命名清洗（TDD）

**Files:**
- Create: `src/main/filename.ts`
- Test: `tests/filename.test.ts`

**Interfaces:**
- Produces: `safeFilename(title: string, author: string, awemeId: string): string`；`ensureUniqueName(dir: string, name: string): string`

- [ ] **Step 1: 写失败测试**

`tests/filename.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { safeFilename, ensureUniqueName } from '../src/main/filename'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('safeFilename', () => {
  it('替换 Windows 非法字符', () => {
    expect(safeFilename('a/b:c*d?e"f<g>h|i', '作者', '12345678')).toContain('_')
    expect(safeFilename('a/b', '作者', '12345678')).not.toMatch(/[\\/:*?"<>|]/)
  })
  it('超 80 截断', () => {
    const long = '长'.repeat(100)
    expect(safeFilename(long, '作者', '12345678').length).toBeLessThanOrEqual(80)
  })
  it('空标题兜底为 作者_id', () => {
    expect(safeFilename('', '作者', '12345678')).toBe('作者_12345678')
  })
  it('含标题+作者+id前8', () => {
    expect(safeFilename('标题', '作者', 'ABCDEFGHIJ')).toBe('标题_作者_ABCDEFGH')
  })
})

describe('ensureUniqueName', () => {
  it('冲突时追加序号', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fn-'))
    writeFileSync(join(dir, 'a.mp4'), '')
    expect(ensureUniqueName(dir, 'a.mp4')).toBe('a_1.mp4')
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/filename.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/filename.ts`:
```ts
import { existsSync } from 'fs'
import { join } from 'path'

export function safeFilename(title: string, author: string, awemeId: string): string {
  const base = `${title}_${author}_${awemeId.slice(0, 8)}`
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const trimmed = base.length > 80 ? base.slice(0, 80) : base
  return trimmed || `${author}_${awemeId}`
}

export function ensureUniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 1
  while (existsSync(join(dir, `${stem}_${i}${ext}`))) i++
  return `${stem}_${i}${ext}`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/filename.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/filename.ts tests/filename.test.ts && git commit -m "feat: 文件命名清洗（TDD）"
```

---

### Task 6: SQLite 封装（TDD）

**Files:**
- Create: `src/main/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `DatabaseSync` 实例（node:sqlite）；`initDb(db)`；`createTask(db, input: CreateTaskInput): number`；`updateTask(db, id, patch)`；`setTaskStatus(db, id, status, error?)`；`incrementFetched(db, id, n)`；`finishTask(db, id)`；`listTasks(db)`；`getRunningTasks(db)`；`upsertAuthor(db, item: VideoItem, platform: string): number`；`listAuthors(db, platform?)`；`insertVideos(db, items, taskId, platform): number`；`listVideos(db, taskId)`；`listPendingVideos(db)`；`setVideoStatus(db, id, status, patch?)`

- [ ] **Step 1: 写失败测试**

`tests/db.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, upsertAuthor, listAuthors, setVideoStatus, listPendingVideos, setTaskStatus } from '../src/main/db'
import type { CreateTaskInput, Filters } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
})

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: '美食',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 } as Filters,
  aiFilterEnabled: false, aiOrganizeEnabled: false
}

const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  awemeId: 'AW1', title: '标题1', authorSecUid: 'SEC1', authorNickname: '作者1',
  authorHomeUrl: 'https://www.douyin.com/user/SEC1', playUrl: 'https://v/play/1',
  durationSec: 60, publishTime: 1710000000, likes: 10, ...over
})

describe('db', () => {
  it('创建任务并回读', () => {
    const id = createTask(db, input)
    const rows = listTasks(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].status).toBe('pending')
  })

  it('insertVideos 去重：同 (platform,aweme_id) 只入一次', () => {
    const id = createTask(db, input)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(1)
    expect(insertVideos(db, [item()], id, 'douyin')).toBe(0)
    expect(listVideos(db, id)).toHaveLength(1)
  })

  it('upsertAuthor 幂等，video_count 累加', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const authors = listAuthors(db)
    expect(authors).toHaveLength(1)
    expect(authors[0].video_count).toBe(2)
  })

  it('setVideoStatus 更新状态', () => {
    const id = createTask(db, input)
    insertVideos(db, [item()], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'downloading')
    expect(listVideos(db, id)[0].status).toBe('downloading')
  })

  it('listPendingVideos 只返回 pending', () => {
    const id = createTask(db, input)
    insertVideos(db, [item({ awemeId: 'AW1' })], id, 'douyin')
    insertVideos(db, [item({ awemeId: 'AW2' })], id, 'douyin')
    const [v] = listVideos(db, id)
    setVideoStatus(db, v.id, 'done')
    expect(listPendingVideos(db).map(x => x.aweme_id).sort()).toEqual(['AW2'])
  })

  it('setTaskStatus 更新任务', () => {
    const id = createTask(db, input)
    setTaskStatus(db, id, 'running')
    setTaskStatus(db, id, 'done')
    expect(listTasks(db)[0].status).toBe('done')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/main/db.ts`:
```ts
import type { DatabaseSync } from 'node:sqlite'
import type { CreateTaskInput, TaskRow, TaskStatus, VideoRow, AuthorRow, VideoStatus } from '../shared/types'
import type { VideoItem } from './adapters/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  type TEXT NOT NULL,
  query TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  target_count INTEGER NOT NULL DEFAULT 200,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  sec_uid TEXT NOT NULL,
  nickname TEXT NOT NULL,
  home_url TEXT,
  video_count INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT,
  note TEXT,
  UNIQUE(platform, sec_uid)
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',
  task_id INTEGER NOT NULL,
  aweme_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author_id INTEGER,
  play_addr TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  publish_time TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  ai_verdict TEXT,
  ai_tags TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  local_path TEXT,
  file_size INTEGER,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  downloaded_at TEXT,
  UNIQUE(platform, aweme_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_task ON videos(task_id);
`

export function initDb(db: DatabaseSync): void {
  db.exec(SCHEMA)
}

export function createTask(db: DatabaseSync, input: CreateTaskInput): number {
  const info = db.prepare(
    `INSERT INTO tasks (platform, type, query, filters, target_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(input.platform, input.type, input.query,
    JSON.stringify({ ...input.filters, aiFilterEnabled: input.aiFilterEnabled, aiOrganizeEnabled: input.aiOrganizeEnabled }),
    input.filters.targetCount, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function updateTask(db: DatabaseSync, id: number, patch: Partial<TaskRow>): void {
  const allowed = ['status', 'filters', 'fetched_count', 'error', 'finished_at'] as const
  const sets: string[] = []
  const vals: unknown[] = []
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]) }
  }
  if (!sets.length) return
  vals.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function setTaskStatus(db: DatabaseSync, id: number, status: TaskStatus, error?: string): void {
  updateTask(db, id, { status, error: error ?? null })
}

export function incrementFetched(db: DatabaseSync, id: number, n: number): void {
  db.prepare('UPDATE tasks SET fetched_count = fetched_count + ? WHERE id = ?').run(n, id)
}

export function finishTask(db: DatabaseSync, id: number): void {
  updateTask(db, id, { status: 'done', finished_at: new Date().toISOString() })
}

export function listTasks(db: DatabaseSync): TaskRow[] {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as TaskRow[]
}

export function getRunningTasks(db: DatabaseSync): TaskRow[] {
  return db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as TaskRow[]
}

export function upsertAuthor(db: DatabaseSync, item: VideoItem, platform: string): number {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO authors (platform, sec_uid, nickname, home_url, video_count, last_fetched_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(platform, sec_uid) DO UPDATE SET
       nickname = excluded.nickname,
       home_url = excluded.home_url,
       video_count = authors.video_count + 1,
       last_fetched_at = excluded.last_fetched_at`
  ).run(platform, item.authorSecUid, item.authorNickname, item.authorHomeUrl, now)
  const row = db.prepare('SELECT id FROM authors WHERE platform = ? AND sec_uid = ?').get(platform, item.authorSecUid) as { id: number }
  return row.id
}

export function listAuthors(db: DatabaseSync, platform?: string): AuthorRow[] {
  if (platform) return db.prepare('SELECT * FROM authors WHERE platform = ? ORDER BY video_count DESC').all(platform) as AuthorRow[]
  return db.prepare('SELECT * FROM authors ORDER BY video_count DESC').all() as AuthorRow[]
}

export function insertVideos(db: DatabaseSync, items: VideoItem[], taskId: number, platform: string): number {
  let inserted = 0
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO videos
       (platform, task_id, aweme_id, title, author_id, play_addr, duration, publish_time, stats, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const authorStmt = db.prepare('SELECT id FROM authors WHERE platform = ? AND sec_uid = ?')
  for (const it of items) {
    const authorId = upsertAuthor(db, it, platform)
    const info = stmt.run(
      platform, taskId, it.awemeId, it.title, authorId, it.playUrl,
      it.durationSec, new Date(it.publishTime * 1000).toISOString(), JSON.stringify({ likes: it.likes }), now
    )
    if (info.changes > 0) inserted++
  }
  void authorStmt
  return inserted
}

export function listVideos(db: DatabaseSync, taskId: number): VideoRow[] {
  return db.prepare('SELECT * FROM videos WHERE task_id = ? ORDER BY id').all(taskId) as VideoRow[]
}

export function listPendingVideos(db: DatabaseSync): VideoRow[] {
  return db.prepare("SELECT * FROM videos WHERE status = 'pending' ORDER BY id").all() as VideoRow[]
}

export function setVideoStatus(db: DatabaseSync, id: number, status: VideoStatus, patch: Partial<VideoRow> = {}): void {
  const sets = ['status = ?']
  const vals: unknown[] = [status]
  for (const k of ['error', 'local_path', 'file_size', 'retry_count', 'downloaded_at', 'ai_verdict', 'ai_tags'] as const) {
    if (k in patch && patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]) }
  }
  vals.push(id)
  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/db.ts tests/db.test.ts && git commit -m "feat: SQLite 封装（TDD）"
```

---

### Task 7: AI 分析器（TDD）

**Files:**
- Create: `src/main/analyzer.ts`
- Test: `tests/analyzer.test.ts`

**Interfaces:**
- Consumes: `AppSettings`（Task 2）
- Produces: `interface FilterVerdict { pass: boolean; reason: string }`；`interface CategoryResult { category: string; tags: string[] }`；`class Analyzer { constructor(cfg, fetchImpl?) ; judgeFilter(text, rule, cacheKey): Promise<FilterVerdict> ; classify(text, cacheKey): Promise<CategoryResult> ; clearCache(): void }`；`extractJsonObject(text: string): unknown | null`

- [ ] **Step 1: 写失败测试**

`tests/analyzer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Analyzer, extractJsonObject } from '../src/main/analyzer'

describe('extractJsonObject', () => {
  it('从带前后缀文本中提取 JSON', () => {
    const text = '好的，结果如下：\n```json\n{"pass": true, "reason": "ok"}\n```\n 完毕'
    expect(extractJsonObject(text)).toEqual({ pass: true, reason: 'ok' })
  })
  it('无 JSON 返回 null', () => {
    expect(extractJsonObject('没有内容')).toBeNull()
  })
})

function mockFetch(jsonBody: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(jsonBody), {
    status: 200, headers: { 'content-type': 'application/json' }
  })) as typeof fetch
}

describe('Analyzer', () => {
  const cfg = { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' }

  it('judgeFilter 解析 pass=true', async () => {
    let capturedBody: any
    const fetchImpl = (async (url: unknown, init?: any) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass":true,"reason":"符合规则"}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    const v = await a.judgeFilter('标题 文案', '只要美食', 'cache-key')
    expect(v).toEqual({ pass: true, reason: '符合规则' })
    expect(capturedBody.model).toBe('m')
    expect(capturedBody.messages.length).toBe(2)
  })

  it('classify 解析分类与标签', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"category":"美食","tags":["探店","小吃"]}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    const r = await a.classify('标题 文案', 'cache-key')
    expect(r).toEqual({ category: '美食', tags: ['探店', '小吃'] })
  })

  it('同 cacheKey 结果缓存，不重复请求', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"pass":true,"reason":"x"}' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    await a.judgeFilter('a', '规则', 'same')
    await a.judgeFilter('a', '规则', 'same')
    expect(calls).toBe(1)
  })

  it('AI 返回非 JSON 时抛 parse 错误', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '抱歉我不懂' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const a = new Analyzer(cfg, fetchImpl)
    await expect(a.judgeFilter('x', '规则', 'k1')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/analyzer.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/analyzer.ts`:
```ts
import type { AppSettings } from '../shared/types'

export interface FilterVerdict { pass: boolean; reason: string }
export interface CategoryResult { category: string; tags: string[] }

/** 从任意文本中提取第一个平衡的 JSON 对象 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } } }
  }
  return null
}

type ChatResp = { choices: Array<{ message: { content: string } }> }

export class Analyzer {
  private cache = new Map<string, unknown>()
  constructor(
    private cfg: Pick<AppSettings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private async chat(system: string, user: string): Promise<unknown> {
    const url = this.cfg.aiBaseUrl.replace(/\/+$/, '') + '/chat/completions'
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.aiApiKey}`
      },
      body: JSON.stringify({
        model: this.cfg.aiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    })
    if (!res.ok) throw new Error(`ai_http_${res.status}`)
    const data = (await res.json()) as ChatResp
    const content = data.choices?.[0]?.message?.content ?? ''
    const parsed = extractJsonObject(content)
    if (parsed === null) throw new Error('ai_parse')
    return parsed
  }

  async judgeFilter(text: string, rule: string, cacheKey: string): Promise<FilterVerdict> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as FilterVerdict
    const parsed = await this.chat(
      '你是视频筛选助手。根据用户规则判断一条视频是否保留。只输出 JSON：{"pass": true/false, "reason": "一句话理由"}。不要输出其他内容。',
      `筛选规则：${rule}\n\n视频信息：${text}`
    ) as Partial<FilterVerdict>
    const verdict: FilterVerdict = { pass: Boolean(parsed.pass), reason: String(parsed.reason ?? '') }
    this.cache.set(cacheKey, verdict)
    return verdict
  }

  async classify(text: string, cacheKey: string): Promise<CategoryResult> {
    const hit = this.cache.get(cacheKey)
    if (hit) return hit as CategoryResult
    const parsed = await this.chat(
      '你是视频分类助手。根据视频信息输出 JSON：{"category": "分类名(2-6字)", "tags": ["标签1","标签2"]}，最多5个标签。不要输出其他内容。',
      `视频信息：${text}`
    ) as Partial<CategoryResult>
    const result: CategoryResult = {
      category: String(parsed.category ?? '未分类'),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : []
    }
    this.cache.set(cacheKey, result)
    return result
  }

  clearCache(): void { this.cache.clear() }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/analyzer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/analyzer.ts tests/analyzer.test.ts && git commit -m "feat: AI 分析器（TDD）"
```

---

### Task 8: 下载器（TDD）

**Files:**
- Create: `src/main/downloader.ts`
- Test: `tests/downloader.test.ts`

**Interfaces:**
- Consumes: `Database`（Task 6）, `AppSettings`（Task 2）, `safeFilename`/`ensureUniqueName`（Task 5）
- Produces: `buildUserAgent(platform: string): string`；`class Downloader { constructor(db, settings, fetchImpl?) ; onEvent(cb); enqueue(id: number): void ; start(): void ; isIdle(): boolean }`；事件 `{ type: 'video:status', id, status, error?, localPath? }`

- [ ] **Step 1: 写失败测试**

`tests/downloader.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initDb, createTask, insertVideos, listVideos, setVideoStatus } from '../src/main/db'
import { Downloader, buildUserAgent } from '../src/main/downloader'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { CreateTaskInput } from '../src/shared/types'
import type { VideoItem } from '../src/main/adapters/types'

let db: DatabaseSync
let dir: string

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initDb(db)
  dir = mkdtempSync(join(tmpdir(), 'dl-'))
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  platform: 'douyin', type: 'keyword', query: 'q',
  filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
  aiFilterEnabled: false, aiOrganizeEnabled: false
}
const item = (): VideoItem => ({
  awemeId: 'AW001', title: '标题', authorSecUid: 'SEC', authorNickname: '作者',
  authorHomeUrl: 'h', playUrl: 'https://cdn.test/v.mp4', durationSec: 10, publishTime: 1710000000, likes: 0
})

describe('buildUserAgent', () => {
  it('包含桌面浏览器标识', () => {
    expect(buildUserAgent('douyin')).toMatch(/Mozilla/)
  })
})

describe('Downloader', () => {
  it('下载成功：写文件、更新状态 done', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)

    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain('cdn.test')
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch

    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    const events: string[] = []
    dl.onEvent(e => events.push(`${e.type}:${e.status}`))
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))

    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('done')
    expect(row.local_path).toBeTruthy()
    expect(existsSync(row.local_path!)).toBe(true)
    expect(readFileSync(row.local_path!)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(events).toContain('video:status:done')
  })

  it('HTTP 500 标记 failed + 错误码 network', async () => {
    const taskId = createTask(db, input)
    insertVideos(db, [item()], taskId, 'douyin')
    const [v] = listVideos(db, taskId)
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch
    const dl = new Downloader(db, { downloadDir: dir, downloadConcurrency: 3, scrollIntervalMs: 2000, addressTtlMin: 30 }, fetchImpl)
    dl.enqueue(v.id)
    dl.start()
    await new Promise(r => setTimeout(r, 50))
    const row = listVideos(db, taskId)[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/downloader.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/downloader.ts`:
```ts
import type { DatabaseSync } from 'node:sqlite'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { join } from 'path'
import type { AppSettings, VideoRow } from '../shared/types'
import { ERROR } from '../shared/types'
import { safeFilename, ensureUniqueName } from './filename'

export function buildUserAgent(_platform: string): string {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
}

type DlSettings = Pick<AppSettings, 'downloadDir' | 'downloadConcurrency' | 'addressTtlMin'>
type DlEvent =
  | { type: 'video:status'; id: number; status: string; error?: string; localPath?: string }

export class Downloader {
  private queue: number[] = []
  private active = 0
  private listeners: Array<(e: DlEvent) => void> = []
  private fetching: Record<number, boolean> = {}

  constructor(
    private db: DatabaseSync,
    private settings: DlSettings,
    private fetchImpl: typeof fetch = fetch
  ) {}

  onEvent(cb: (e: DlEvent) => void): void { this.listeners.push(cb) }

  enqueue(id: number): void {
    if (this.fetching[id]) return
    this.fetching[id] = true
    this.queue.push(id)
    this.drain()
  }

  start(): void { this.drain() }

  isIdle(): boolean { return this.active === 0 && this.queue.length === 0 }

  private emit(e: DlEvent): void { for (const l of this.listeners) l(e) }

  private drain(): void {
    const concurrency = this.settings.downloadConcurrency || 3
    while (this.active < concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!
      void this.runOne(id).finally(() => {
        this.active--
        this.drain()
      })
      this.active++
    }
  }

  private async runOne(id: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined
    if (!row) return
    try {
      this.db.prepare("UPDATE videos SET status = 'downloading' WHERE id = ?").run(id)
      this.emit({ type: 'video:status', id, status: 'downloading' })

      const author = row.author_id
        ? (this.db.prepare('SELECT nickname FROM authors WHERE id = ?').get(row.author_id) as { nickname: string } | undefined)
        : undefined
      const name = safeFilename(row.title, author?.nickname ?? 'unknown', row.aweme_id)
      const finalName = ensureUniqueName(this.settings.downloadDir, `${name}.mp4`)
      const dest = join(this.settings.downloadDir, finalName)

      const res = await this.fetchImpl(row.play_addr!, {
        headers: { 'user-agent': buildUserAgent(row.platform), referer: `https://www.${row.platform}.com/` }
      })
      if (!res.ok || !res.body) throw new Error(`http_${res.status}`)
      await pipeline(res.body, createWriteStream(dest))

      const size = await import('fs').then(m => m.statSync(dest).size)
      const patch: Partial<VideoRow> = { local_path: dest, file_size: size, downloaded_at: new Date().toISOString(), error: null }
      this.db.prepare("UPDATE videos SET status='done', local_path=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
        .run(dest, size, patch.downloaded_at, id)
      this.emit({ type: 'video:status', id, status: 'done', localPath: dest })
    } catch (err) {
      const retry = row.retry_count + 1
      const code = ERROR.NETWORK
      this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=? WHERE id=?")
        .run(code, retry, id)
      this.emit({ type: 'video:status', id, status: 'failed', error: code })
    } finally {
      delete this.fetching[id]
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/downloader.test.ts`
Expected: PASS（网络重试次数在 Task 15 加强，此处先保最小实现）

- [ ] **Step 5: 提交**

```bash
git add src/main/downloader.ts tests/downloader.test.ts && git commit -m "feat: 下载器（TDD）"
```

---

### Task 9: 内置浏览器 + 挂钩脚本 + 消息桥

**Files:**
- Create: `src/main/injector.ts`
- Create: `src/main/browser.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `PlatformAdapter`（Task 2）
- Produces: `INJECT_SCRIPT: string`（挂钩脚本）；`class VideoBrowser { constructor(hostWindow: BrowserWindow, onRaw: (url: string, json: unknown) => void) ; init(): Promise<void> ; load(adapter: PlatformAdapter, url: string): Promise<void> ; scrollToBottom(): void ; setVisible(v: boolean): void ; dispose(): void }`

- [ ] **Step 1: 写挂钩脚本**

`src/main/injector.ts`:
```ts
export const INJECT_SCRIPT = `(() => {
  const post = (url, data) => {
    try { window.postMessage({ type: 'dy:raw', url, data }, '*') } catch (e) { /* ignore */ }
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(res => {
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) {
          res.clone().text().then(txt => {
            try { post(res.url, JSON.parse(txt)) } catch (e) { /* ignore */ }
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    });
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dyUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (ct.includes('json')) { try { post(this.__dyUrl, JSON.parse(this.responseText)) } catch (e) { /* ignore */ } }
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };
})();`
```

- [ ] **Step 2: 写浏览器封装**

`src/main/browser.ts`:
```ts
import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import type { PlatformAdapter } from './adapters/types'
import { INJECT_SCRIPT } from './injector'

export class VideoBrowser {
  private view: WebContentsView | null = null

  constructor(
    private host: BrowserWindow,
    private onRaw: (url: string, json: unknown) => void,
    private inject: string = INJECT_SCRIPT
  ) {}

  async init(): Promise<void> {
    const view = new WebContentsView({ webPreferences: { partition: 'persist:douyin', preload: join(__dirname, '../preload/index.js') } })
    view.setVisible(false)
    this.host.contentView.addChildView(view)
    this.view = view

    view.webContents.on('did-finish-load', () => {
      void view.webContents.executeJavaScript(this.inject).catch(() => { /* 页面脚本执行失败不影响主流程 */ })
    })
    view.webContents.on('did-navigate', () => {
      void view.webContents.executeJavaScript(this.inject).catch(() => { /* ignore */ })
    })
  }

  async load(adapter: PlatformAdapter, url: string): Promise<void> {
    if (!this.view) throw new Error('browser_not_initialized')
    const wc = this.view.webContents
    await wc.loadURL(url)
  }

  async scrollToBottom(): Promise<void> {
    if (!this.view) return
    await this.view.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {})
  }

  setVisible(v: boolean): void {
    if (!this.view) return
    const [w, h] = this.host.getContentSize()
    if (v) this.view.setBounds({ x: 0, y: 0, width: w, height: h })
    this.view.setVisible(v)
    void this.host
  }

  dispose(): void {
    if (this.view) {
      this.host.contentView.removeChildView(this.view)
      this.view = null
    }
  }
}
```

- [ ] **Step 3: preload 加消息桥**

`src/preload/index.ts`（整体替换）:
```ts
import { contextBridge, ipcRenderer } from 'electron'

// 页面世界经 window.postMessage 发来的原始 JSON → 主进程
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (d && typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('dy:')) {
    ipcRenderer.send('dy:raw', { url: d.url ?? '', json: d.data })
  }
})

contextBridge.exposeInMainWorld('api', {
  ping: (): string => ipcRenderer.sendSync('api:ping') as string
})
```

- [ ] **Step 4: 主进程装配（临时接线验证）**

`src/main/index.ts` 中，把 `createWindow` 改为模块级 `win`，并追加临时接线：
```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { VideoBrowser } from './browser'
import { douyinAdapter } from './adapters/douyin'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
const rawLogs: Array<{ url: string }> = []

function handleRawJson(url: string, json: unknown): void {
  rawLogs.push({ url })
  // TODO(Task 11): 正式接线，这里先打日志验证挂钩生效
  win?.webContents.send('dbg:raw', { url, count: rawLogs.length })
}

app.whenReady().then(() => {
  createWindow()
  browser = new VideoBrowser(win!, (url, json) => {
    if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) handleRawJson(url, json)
  })
  void browser.init().then(() => {
    if (browser) void browser.load(douyinAdapter, 'https://www.douyin.com/')
  })
})

ipcMain.handle('browser:show', () => { browser?.setVisible(true) })
ipcMain.handle('browser:hide', () => { browser?.setVisible(false) })
ipcMain.handle('browser:scroll', () => browser?.scrollToBottom())
ipcMain.on('dy:raw', (_e, msg) => {
  const url = String(msg?.url ?? '')
  if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) handleRawJson(url, msg?.json)
})
```
（注意：`createWindow` 内 `win = new BrowserWindow(...)` 赋值给模块级 `win`。）

- [ ] **Step 5: 手动验证挂钩生效**

Run: `npm run dev`，在渲染层 DevTools（Ctrl+Shift+I）执行：
```js
window.api.ping() // 'pong'
```
然后在 内置浏览器 tab 逻辑接好前，用 `navigator` 手动触发不了接口，改为：打开 https://www.douyin.com 扫码登录后，手动滚动页面触发搜索接口，观察主进程控制台是否打印 `dy:raw` 命中日志。
Expected: 登录后滚动页面能观察到原始 JSON 到达主进程（url 匹配 `aweme/v1/web/`）。

- [ ] **Step 6: 提交**

```bash
git add src/main/injector.ts src/main/browser.ts src/preload/index.ts src/main/index.ts && git commit -m "feat: 内置浏览器+挂钩脚本+消息桥"
```

---

### Task 10: 调度器

**Files:**
- Create: `src/main/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `VideoBrowser`（Task 9）, 适配器（Task 3）, `filterVideos`/`dedupeVideos`（Task 4）, `db`（Task 6）, `Analyzer`（Task 7）, `Downloader`（Task 8）
- Produces: `buildStopDecision(fetched, target, emptyRounds): 'continue' | 'reached' | 'stop'`；`class Scheduler { constructor(deps) ; async run(taskId): Promise<void> ; stop(): void ; pause(): void ; resume(): void }`；事件 `{ type: 'task:progress', taskId, fetched, status }`、`{ type: 'task:done', taskId }`、`{ type: 'task:paused', taskId, reason }`

- [ ] **Step 1: 写停止决策测试**

`tests/scheduler.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildStopDecision } from '../src/main/scheduler'

describe('buildStopDecision', () => {
  it('达到目标 → reached', () => expect(buildStopDecision(200, 200, 0)).toBe('reached'))
  it('连续5轮空 → stop', () => expect(buildStopDecision(100, 200, 5)).toBe('stop'))
  it('否则继续', () => expect(buildStopDecision(100, 200, 2)).toBe('continue'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现调度器**

先建适配器注册表（Task 11 的 IPC 会用，避免后续任务缺文件；若已存在则跳过）：

`src/main/adapters/index.ts`:
```ts
import type { PlatformAdapter } from './types'
import { douyinAdapter } from './douyin'

const registry: Record<string, PlatformAdapter> = { douyin: douyinAdapter }

export function getAdapter(name: string): PlatformAdapter | undefined {
  return registry[name]
}

export function listAdapters(): Array<{ name: string; displayName: string }> {
  return Object.values(registry).map(a => ({ name: a.name, displayName: a.displayName }))
}
```

`src/main/scheduler.ts`:
```ts
import type { DatabaseSync } from 'node:sqlite'
import type { PlatformAdapter } from './adapters/types'
import type { TaskRow, TaskStatus } from '../shared/types'
import { ERROR } from '../shared/types'
import { filterVideos, dedupeVideos } from './extractor'
import type { Analyzer } from './analyzer'
import type { Downloader } from './downloader'
import type { VideoBrowser } from './browser'
import { getAdapter } from './adapters'

export function buildStopDecision(fetched: number, target: number, emptyRounds: number): 'continue' | 'reached' | 'stop' {
  if (fetched >= target) return 'reached'
  if (emptyRounds >= 5) return 'stop'
  return 'continue'
}

export type SchedulerEvent =
  | { type: 'task:progress'; taskId: number; fetched: number; status: TaskStatus }
  | { type: 'task:done'; taskId: number; fetched: number }
  | { type: 'task:paused'; taskId: number; reason: string }

interface SchedulerDeps {
  db: DatabaseSync
  browser: VideoBrowser
  analyzer: Analyzer | null
  downloader: Downloader
  emit: (e: SchedulerEvent) => void
  scrollIntervalMs: number
}

export class Scheduler {
  private aborted = false
  constructor(private deps: SchedulerDeps) {}

  stop(): void { this.aborted = true }
  pause(): void { this.aborted = true }

  async run(taskId: number): Promise<void> {
    this.aborted = false
    const db = this.deps.db
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) return
    const adapter = getAdapter(task.platform)
    if (!adapter) { this.fail(taskId, ERROR.PARSE_ERROR); return }

    db.prepare("UPDATE tasks SET status='running', error=NULL WHERE id=?").run(taskId)
    const filters = JSON.parse(task.filters)
    const seen = new Set<string>((db.prepare('SELECT aweme_id FROM videos WHERE platform=?').all(task.platform) as Array<{ aweme_id: string }>).map(r => r.aweme_id))

    let fetched = task.fetched_count
    let emptyRounds = 0
    const aiEnabled = !!(this.deps.analyzer) && !!filters.aiFilterEnabled

    const url = task.type === 'author'
      ? adapter.buildAuthorUrl(task.query)
      : task.type === 'hashtag'
        ? adapter.buildHashtagUrl(task.query)
        : adapter.buildSearchUrl(task.query, filters)
    await this.deps.browser.load(adapter, url)

    const pendingVideoIds: number[] = []
    const cookiePromise = this.getCookieHeader(task.platform)

    this.deps.browser.onRaw(async (rawUrl, json) => {
      if (!adapter.apiUrlPatterns.some(r => r.test(rawUrl))) return
      const items = adapter.parseApiJson(rawUrl, json)
      const kept = dedupeVideos(filterVideos(items, filters), seen)
      if (kept.length === 0) { emptyRounds++; return }
      emptyRounds = 0

      for (const item of kept) {
        if (this.aborted) return
        if (aiEnabled && this.deps.analyzer) {
          try {
            const text = `${item.title}\n作者:${item.authorNickname}\n时长:${item.durationSec}s`
            const v = await this.deps.analyzer.judgeFilter(text, filters.aiFilterRule ?? '', `${item.awemeId}:filter`)
            if (!v.pass) {
              const insertedId = db.prepare(
                "INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,play_addr,duration,publish_time,status,ai_verdict,fetched_at) VALUES (?,?,?,?,?,?,?,'filtered','filtered',?)"
              ).run(task.platform, taskId, item.awemeId, item.title, item.playUrl, item.durationSec,
                   new Date(item.publishTime * 1000).toISOString(), new Date().toISOString())
              if (insertedId.changes > 0) db.prepare('UPDATE tasks SET fetched_count = fetched_count + 1 WHERE id=?').run(taskId)
              continue
            }
          } catch { /* AI 失败降级：视为通过 */ }
        }
        const authorId = db.prepare('SELECT id FROM authors WHERE platform=? AND sec_uid=?').get(task.platform, item.authorSecUid) as { id: number } | undefined
        const aiVerdict = 'pass'
        const info = db.prepare(
          `INSERT OR IGNORE INTO videos (platform,task_id,aweme_id,title,author_id,play_addr,duration,publish_time,stats,status,ai_verdict,fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'pending',?,?)`
        ).run(task.platform, taskId, item.awemeId, item.title, authorId?.id ?? null, item.playUrl,
             item.durationSec, new Date(item.publishTime * 1000).toISOString(), JSON.stringify({ likes: item.likes }),
             aiVerdict, new Date().toISOString())
        if (info.changes > 0) {
          fetched++
          const vid = Number(info.lastInsertRowid)
          pendingVideoIds.push(vid)
          this.deps.downloader.enqueue(vid)
        }
      }
      db.prepare('UPDATE tasks SET fetched_count=? WHERE id=?').run(fetched, taskId)
      this.deps.emit({ type: 'task:progress', taskId, fetched, status: 'running' })
    })

    while (!this.aborted) {
      await sleep(this.deps.scrollIntervalMs + Math.random() * 1500)
      await this.deps.browser.scrollToBottom()
      const decision = buildStopDecision(fetched, filters.targetCount ?? 200, emptyRounds)
      if (decision === 'reached' || decision === 'stop') break
      if (pendingVideoIds.length > 30) { /* 下载堆积，放慢抓取 */ await sleep(2000) }
    }
    void cookiePromise

    if (this.aborted) {
      db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(taskId)
      this.deps.emit({ type: 'task:paused', taskId, reason: '用户暂停或风控' })
    } else {
      db.prepare("UPDATE tasks SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId)
      this.deps.emit({ type: 'task:done', taskId, fetched })
    }
  }

  private fail(taskId: number, code: string): void {
    this.deps.db.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?").run(code, taskId)
  }

  private async getCookieHeader(platform: string): Promise<string> {
    try {
      const { session } = await import('electron')
      const ses = session.fromPartition(`persist:${platform}`)
      const cookies = await ses.cookies.get({})
      return cookies.map(c => `${c.name}=${c.value}`).join('; ')
    } catch { return '' }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
```

- [ ] **Step 4: 运行停止决策测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: 手动联调（真实抖音小规模验证）**

Run: `npm run dev`，内置浏览器登录抖音后，在渲染层触发一个关键词任务（Task 11 的 IPC 接通前可先在主进程写死临时任务），观察：滚动翻页、`aweme/v1/web/` JSON 命中、videos 表入库、下载器开始下载。
Expected: 任务进度推进，输出目录出现带标题的无水印 mp4。

- [ ] **Step 6: 提交**

```bash
git add src/main/scheduler.ts tests/scheduler.test.ts && git commit -m "feat: 调度器（含停止决策 TDD）"
```

---

### Task 11: 设置存储 + IPC 装配

**Files:**
- Create: `src/main/settings.ts`
- Create: `src/main/ipc.ts`
- Create: `src/main/adapters/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

**Interfaces:**
- Consumes: 全部主进程模块
- Produces: `getSettings(): AppSettings`；`saveSettings(s: AppSettings)`；`getPlatforms(): Array<{ name, displayName }>`；`testAiConnection(): Promise<{ ok: boolean; error?: string }>`；渲染层 `window.api` 完整面（见 preload）

- [ ] **Step 1: 适配器注册表**

已在 Task 10 Step 3 创建 `src/main/adapters/index.ts`，此处直接复用；若缺文件则补建（内容同 Task 10）。

- [ ] **Step 2: 写设置存储**

`src/main/settings.ts`:
```ts
import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  downloadDir: join(app.getPath('downloads'), '爬取视频'),
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  downloadConcurrency: 3,
  scrollIntervalMs: 2000,
  addressTtlMin: 30
}

export function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8')
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch { return { ...DEFAULTS } }
}

export function saveSettings(s: AppSettings): void {
  const f = settingsFile()
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf-8')
}
```

- [ ] **Step 3: 写 IPC 处理**

`src/main/ipc.ts`:
```ts
import { ipcMain, BrowserWindow } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { createTask, listTasks, listVideos, listAuthors, setTaskStatus, setVideoStatus, listPendingVideos } from './db'
import { getSettings, saveSettings } from './settings'
import { listAdapters } from './adapters'
import type { Scheduler } from './scheduler'
import type { Downloader } from './downloader'
import type { Analyzer } from './analyzer'
import { getAdapter } from './adapters'
import type { VideoBrowser } from './browser'

export interface IpcDeps {
  db: DatabaseSync
  scheduler: Scheduler
  downloader: Downloader
  analyzer: Analyzer | null
  browser: VideoBrowser
  getWindow: () => BrowserWindow
}

export function registerIpc(deps: IpcDeps): void {
  const { db, scheduler, downloader, browser } = deps

  ipcMain.handle('api:ping', () => 'pong')
  ipcMain.handle('platforms:list', () => listAdapters())

  ipcMain.handle('task:create', (_e, input: Parameters<typeof createTask>[1]) => {
    const id = createTask(db, input)
    void scheduler.run(id)
    return id
  })

  ipcMain.handle('task:list', () => listTasks(db))
  ipcMain.handle('task:video:list', (_e, taskId: number) => listVideos(db, taskId))
  ipcMain.handle('task:pause', (_e, id: number) => { scheduler.pause(); setTaskStatus(db, id, 'paused', 'user') })
  ipcMain.handle('task:resume', (_e, id: number) => { void scheduler.run(id) })
  ipcMain.handle('task:delete', (_e, id: number) => { db.prepare('DELETE FROM videos WHERE task_id=?').run(id); db.prepare('DELETE FROM tasks WHERE id=?').run(id) })

  ipcMain.handle('video:retry', (_e, ids: number[]) => {
    for (const id of ids) {
      setVideoStatus(db, id, 'pending', { error: null })
      downloader.enqueue(id)
    }
    return true
  })

  ipcMain.handle('authors:list', () => listAuthors(db))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, s: Parameters<typeof saveSettings>[0]) => saveSettings(s))

  ipcMain.handle('ai:test', async () => {
    const s = getSettings()
    if (!s.aiApiKey || !s.aiBaseUrl) return { ok: false, error: '未配置 API Key' }
    const a = new Analyzer(s)
    try { await a.judgeFilter('测试', '总是通过', 'test') ; return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('browser:show', () => browser.setVisible(true))
  ipcMain.handle('browser:hide', () => browser.setVisible(false))
}
```

- [ ] **Step 4: preload 暴露完整 API**

`src/preload/index.ts`（在消息桥基础上追加）:
```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, AppSettings } from '../shared/types'

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (d && typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('dy:')) {
    ipcRenderer.send('dy:raw', { url: d.url ?? '', json: d.data })
  }
})

const api = {
  ping: () => ipcRenderer.sendSync('api:ping') as string,
  listPlatforms: (): Promise<Array<{ name: string; displayName: string }>> => ipcRenderer.invoke('platforms:list'),
  createTask: (input: CreateTaskInput): Promise<number> => ipcRenderer.invoke('task:create', input),
  listTasks: (): Promise<unknown[]> => ipcRenderer.invoke('task:list'),
  listTaskVideos: (taskId: number): Promise<unknown[]> => ipcRenderer.invoke('task:video:list', taskId),
  pauseTask: (id: number): Promise<void> => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id: number): Promise<void> => ipcRenderer.invoke('task:resume', id),
  deleteTask: (id: number): Promise<void> => ipcRenderer.invoke('task:delete', id),
  retryVideos: (ids: number[]): Promise<boolean> => ipcRenderer.invoke('video:retry', ids),
  listAuthors: (): Promise<unknown[]> => ipcRenderer.invoke('authors:list'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:save', s),
  testAi: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ai:test'),
  showBrowser: (): Promise<void> => ipcRenderer.invoke('browser:show'),
  hideBrowser: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
  onTaskProgress: (cb: (e: unknown) => void): (() => void) => {
    const l = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('evt:task:progress', l)
    return () => ipcRenderer.removeListener('evt:task:progress', l)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```

`src/preload/index.d.ts`：
```ts
import type { Api } from './index'
declare global { interface Window { api: Api } }
export {}
```

- [ ] **Step 5: 装配主进程 + 事件推送**

`src/main/index.ts` 整体替换为（保留 Task 1 的窗口创建）:
```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from './db'
import { VideoBrowser } from './browser'
import { Scheduler } from './scheduler'
import { Downloader } from './downloader'
import { Analyzer } from './analyzer'
import { registerIpc } from './ipc'
import { getSettings } from './settings'
import { douyinAdapter } from './adapters/douyin'

let win: BrowserWindow | null = null
let browser: VideoBrowser | null = null
let downloader: Downloader | null = null
let scheduler: Scheduler | null = null
let analyzer: Analyzer | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, title: '视频爬取工具',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function push(evt: unknown): void {
  win?.webContents.send('evt:task:progress', evt)
}

app.whenReady().then(() => {
  const db = new DatabaseSync(join(app.getPath('userData'), 'scraper.db'))
  initDb(db)

  createWindow()

  const settings = getSettings()
  analyzer = settings.aiApiKey ? new Analyzer(settings) : null
  downloader = new Downloader(db, settings)
  browser = new VideoBrowser(win!, (url, json) => {
    if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) {
      void scheduler?.handleRaw(douyinAdapter, url, json)
    }
  })

  scheduler = new Scheduler({
    db, browser, analyzer, downloader,
    emit: push,
    scrollIntervalMs: settings.scrollIntervalMs
  })

  registerIpc({ db, scheduler, downloader, analyzer, browser, getWindow: () => win! })

  void browser.init()
  downloader.onEvent(e => push(e))

  // 断点续传：running→paused；pending 视频重新入队
  const running = db.prepare("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: number }>
  for (const t of running) db.prepare("UPDATE tasks SET status='paused', error='interrupted' WHERE id=?").run(t.id)
  const pend = db.prepare("SELECT id FROM videos WHERE status='pending'").all() as Array<{ id: number }>
  for (const v of pend) downloader.enqueue(v.id)
  downloader.start()

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

ipcMain.on('dy:raw', (_e, msg) => {
  const url = String(msg?.url ?? '')
  const json = msg?.json
  if (douyinAdapter.apiUrlPatterns.some(r => r.test(url))) {
    void scheduler?.handleRaw(douyinAdapter, url, json)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

注意：`Scheduler` 需补一个 `handleRaw(adapter, url, json)` 方法（把 Task 10 里的 onRaw 回调逻辑提成公开方法，供主进程直接调用；同时删除 Task 10 中 browser.onRaw 注册，改为主进程统一转发）。

- [ ] **Step 6: 手动验证 IPC**

Run: `npm run dev`，渲染层 DevTools 执行：
```js
await window.api.listPlatforms()   // [{name:'douyin', displayName:'抖音'}]
await window.api.getSettings()
await window.api.createTask({ platform:'douyin', type:'keyword', query:'美食', filters:{ timeRange:'all', duration:'all', targetCount:200 }, aiFilterEnabled:false, aiOrganizeEnabled:false })
await window.api.listTasks()
```
Expected: 任务创建成功且 status 进入 running，控制台出现进度事件。

- [ ] **Step 7: 提交**

```bash
git add src/main/settings.ts src/main/ipc.ts src/main/adapters/index.ts src/main/index.ts src/preload && git commit -m "feat: 设置存储+IPC装配+事件推送"
```

---

### Task 12: 渲染层基础 + 筛选表单

**Files:**
- Create: `src/renderer/src/api.ts`
- Create: `src/renderer/src/components/FilterForm.tsx`
- Create: `src/renderer/src/components/ui.tsx`（Tab 栏等小原子组件）
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/index.css`

**Interfaces:**
- Consumes: `window.api`（Task 11）
- Produces: `FilterForm` 受控组件：平台下拉、类型单选、输入、时间/时长下拉、目标数量(200-1000 校验)、AI 开关与规则、提交回调

- [ ] **Step 1: 写 api 包装**

`src/renderer/src/api.ts`:
```ts
import type { CreateTaskInput, AppSettings, TaskRow, VideoRow, AuthorRow } from '../../../shared/types'

export const api = window.api

export type { CreateTaskInput, AppSettings, TaskRow, VideoRow, AuthorRow }
```

- [ ] **Step 2: 写 UI 原子组件**

`src/renderer/src/components/ui.tsx`:
```tsx
import React from 'react'

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ key: string; label: string }>; active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-zinc-200 bg-white px-4">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`px-4 py-3 text-sm font-medium transition-colors ${active === t.key ? 'border-b-2 border-blue-600 text-blue-600' : 'text-zinc-500 hover:text-zinc-800'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      {title && <h3 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h3>}
      {children}
    </div>
  )
}

export const inputCls = 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
export const btnPrimary = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40'
```

- [ ] **Step 3: 写筛选表单**

`src/renderer/src/components/FilterForm.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { CreateTaskInput, Filters, TaskType } from '../../../shared/types'
import { btnPrimary, inputCls, Card } from './ui'

export default function FilterForm({ onSubmit }: { onSubmit: (t: CreateTaskInput) => void }) {
  const [platforms, setPlatforms] = useState<Array<{ name: string; displayName: string }>>([])
  const [platform, setPlatform] = useState('douyin')
  const [type, setType] = useState<TaskType>('keyword')
  const [query, setQuery] = useState('')
  const [timeRange, setTimeRange] = useState<Filters['timeRange']>('all')
  const [duration, setDuration] = useState<Filters['duration']>('all')
  const [target, setTarget] = useState(200)
  const [aiFilter, setAiFilter] = useState(false)
  const [aiRule, setAiRule] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { void api.listPlatforms().then(setPlatforms) }, [])

  const targetValid = target >= 200 && target <= 1000

  function submit(): void {
    if (!query.trim()) { setErr('请输入关键词/作者/话题'); return }
    if (!targetValid) { setErr('目标数量需在 200-1000 之间'); return }
    if (aiFilter && !aiRule.trim()) { setErr('开启先审后下需填写筛选规则'); return }
    setErr('')
    onSubmit({
      platform, type, query: query.trim(),
      filters: { timeRange, duration, targetCount: target, aiFilterRule: aiFilter ? aiRule.trim() : undefined },
      aiFilterEnabled: aiFilter, aiOrganizeEnabled: false
    })
    setQuery('')
  }

  return (
    <Card title="筛选条件">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          平台
          <select className={inputCls} value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 text-sm">
          {(['keyword', 'author', 'hashtag'] as const).map(t => (
            <label key={t} className="flex items-center gap-1">
              <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
              {t === 'keyword' ? '关键词' : t === 'author' ? '作者' : '话题'}
            </label>
          ))}
        </div>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-500 min-w-[200px]">
          {type === 'keyword' ? '关键词' : type === 'author' ? '作者主页链接或 ID' : '话题'}
          <input className={inputCls} value={query} onChange={e => setQuery(e.target.value)} placeholder={type === 'author' ? 'https://www.douyin.com/user/xxx' : '输入内容'} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          时间
          <select className={inputCls} value={timeRange} onChange={e => setTimeRange(e.target.value as Filters['timeRange'])}>
            <option value="all">全部</option><option value="7d">近7天</option><option value="30d">近30天</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          时长
          <select className={inputCls} value={duration} onChange={e => setDuration(e.target.value as Filters['duration'])}>
            <option value="all">全部</option><option value="short">短(<1分钟)</option><option value="medium">中(1-5分钟)</option><option value="long">长(>5分钟)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          目标数量
          <input type="number" className={inputCls} value={target}
            onChange={e => setTarget(Number(e.target.value))} min={200} max={1000} />
          {!targetValid && <span className="text-red-500">需在 200-1000</span>}
        </label>
        <button className={btnPrimary} onClick={submit} disabled={!targetValid}>开始抓取</button>
      </div>
      <div className="mt-3 flex items-center gap-6 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={aiFilter} onChange={e => setAiFilter(e.target.checked)} />
          AI 先审后下
        </label>
        {aiFilter && (
          <input className={`${inputCls} flex-1`} value={aiRule} onChange={e => setAiRule(e.target.value)}
            placeholder="筛选规则，如：只要美食教程，不要游戏直播" />
        )}
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </Card>
  )
}
```

- [ ] **Step 4: 更新 App 布局**

`src/renderer/src/App.tsx`:
```tsx
import React, { useState } from 'react'
import { Tabs } from './components/ui'
import FilterForm from './components/FilterForm'
import { api } from './api'
import type { CreateTaskInput } from '../../shared/types'

export default function App(): JSX.Element {
  const [tab, setTab] = useState('panel')

  async function startTask(input: CreateTaskInput): Promise<void> {
    await api.createTask(input)
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-800">
      <header className="border-b border-zinc-200 bg-white px-4 py-2 text-base font-semibold">视频爬取工具</header>
      <Tabs
        active={tab} onChange={k => {
          setTab(k)
          if (k === 'browser') void api.showBrowser()
          else void api.hideBrowser()
        }}
        tabs={[{ key: 'panel', label: '管理面板' }, { key: 'browser', label: '内置浏览器' }, { key: 'settings', label: '设置' }]}
      />
      <main className="flex-1 overflow-auto p-4">
        {tab === 'panel' && (
          <div className="space-y-4">
            <FilterForm onSubmit={startTask} />
            {/* Task 13 任务列表 / 作者收藏 */}
            <div id="task-list-slot" className="text-sm text-zinc-400">任务列表区域（下一步实现）</div>
            <div id="authors-slot" className="text-sm text-zinc-400">作者收藏区域（下一步实现）</div>
          </div>
        )}
        {tab === 'settings' && <div className="text-sm text-zinc-400">设置页（下一步实现）</div>}
      </main>
    </div>
  )
}
```

- [ ] **Step 5: 手动验证**

Run: `npm run dev`
Expected: 三个标签可切换；管理面板表单齐全；目标数量输 100 出红字校验；点"内置浏览器"能显示内嵌抖音页（需已登录）。

- [ ] **Step 6: 提交**

```bash
git add src/renderer && git commit -m "feat: 渲染层基础+筛选表单"
```

---

### Task 13: 任务列表 + 作者收藏

**Files:**
- Create: `src/renderer/src/components/TaskList.tsx`
- Create: `src/renderer/src/components/AuthorCollection.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `api.listTasks`, `api.listTaskVideos`, `api.listAuthors`, `api.retryVideos`, `api.pauseTask`, `api.resumeTask`, `api.deleteTask`, `api.onTaskProgress`（Task 11）
- Produces: 任务表格（进度条/展开视频列表/失败重试/暂停继续/删除）、作者卡片（爬主页按钮）

- [ ] **Step 1: 写任务列表**

`src/renderer/src/components/TaskList.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { TaskRow, VideoRow } from '../../../shared/types'
import { Card, btnPrimary, inputCls } from './ui'

const STATUS_LABEL: Record<string, string> = { pending: '等待中', running: '进行中', done: '完成', paused: '已暂停', failed: '失败' }

export default function TaskList() {
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [videos, setVideos] = useState<Record<number, VideoRow[]>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const refresh = () => { void api.listTasks().then(setTasks) }

  useEffect(() => {
    refresh()
    const off = api.onTaskProgress(refresh)
    return off
  }, [])

  async function toggleExpand(id: number): Promise<void> {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id); else { next.add(id); setVideos(prev => ({ ...prev, [id]: (await api.listTaskVideos(id)) })) }
    setExpanded(next)
  }

  function toggleSelect(id: number): void {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const selectedVideoIds = Object.entries(videos).flatMap(([tid, vs]) =>
    selected.has(Number(tid)) ? [] : vs.filter(v => v.status === 'failed' && selected.has(v.id)).map(v => v.id)
  )

  return (
    <Card title="任务列表">
      <div className="space-y-2">
        {tasks.map(t => {
          const pct = t.target_count ? Math.min(100, Math.round((t.fetched_count / t.target_count) * 100)) : 0
          return (
            <div key={t.id} className="rounded-md border border-zinc-200 p-3">
              <div className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} />
                <span className="w-24 truncate text-zinc-500">{t.platform}/{t.type}</span>
                <span className="min-w-0 flex-1 truncate font-medium">"{t.query}"</span>
                <span className="text-zinc-500">{t.fetched_count}/{t.target_count}</span>
                <div className="h-2 w-40 overflow-hidden rounded bg-zinc-200">
                  <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                </div>
                <span className={`w-16 text-center text-xs ${t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-blue-600' : 'text-zinc-500'}`}>
                  {STATUS_LABEL[t.status]}
                </span>
                <button className="text-xs text-zinc-400" onClick={() => void toggleExpand(t.id)}>{expanded.has(t.id) ? '收起' : '展开'}</button>
                <button className="text-xs text-zinc-400" onClick={() => { void (t.status === 'running' ? api.pauseTask(t.id) : api.resumeTask(t.id)).then(refresh) }}>
                  {t.status === 'running' ? '暂停' : t.status === 'paused' ? '继续' : ''}
                </button>
                <button className="text-xs text-red-400" onClick={() => { void api.deleteTask(t.id).then(refresh) }}>删除</button>
              </div>
              {expanded.has(t.id) && (
                <div className="mt-2 max-h-48 overflow-auto border-t border-zinc-100 pl-7 text-xs">
                  {(videos[t.id] ?? []).map(v => (
                    <div key={v.id} className="flex items-center gap-2 py-1">
                      <span className="w-10 text-zinc-400">{v.status}</span>
                      <span className="min-w-0 flex-1 truncate">{v.title}</span>
                      {v.ai_verdict === 'filtered' && <span className="text-amber-500">AI已过滤</span>}
                      {v.status === 'failed' && <button className="text-blue-500" onClick={() => { void api.retryVideos([v.id]).then(refresh) }}>重试</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
```

- [ ] **Step 2: 写作者收藏**

`src/renderer/src/components/AuthorCollection.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AuthorRow } from '../../../shared/types'
import { Card, btnPrimary } from './ui'

export default function AuthorCollection() {
  const [authors, setAuthors] = useState<AuthorRow[]>([])
  useEffect(() => { void api.listAuthors().then(setAuthors) }, [])

  async function crawlHome(a: AuthorRow): Promise<void> {
    await api.createTask({
      platform: a.platform, type: 'author', query: a.sec_uid,
      filters: { timeRange: 'all', duration: 'all', targetCount: 200 },
      aiFilterEnabled: false, aiOrganizeEnabled: false
    })
  }

  return (
    <Card title="作者收藏">
      <div className="flex flex-wrap gap-2">
        {authors.map(a => (
          <div key={`${a.platform}:${a.sec_uid}`} className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm">
            <span className="font-medium">{a.nickname}</span>
            <span className="text-xs text-zinc-400">{a.video_count}个视频</span>
            <button className={`${btnPrimary} !px-2 !py-1 !text-xs`} onClick={() => void crawlHome(a)}>爬主页</button>
          </div>
        ))}
        {authors.length === 0 && <span className="text-sm text-zinc-400">暂无收藏的作者，抓取后自动收录</span>}
      </div>
    </Card>
  )
}
```

- [ ] **Step 3: 接入 App**

`src/renderer/src/App.tsx` 的 panel 分支改为：
```tsx
<div className="space-y-4">
  <FilterForm onSubmit={startTask} />
  <TaskList />
  <AuthorCollection />
</div>
```
（import 两个组件）

- [ ] **Step 4: 手动验证**

Run: `npm run dev`，创建一个任务（真实跑一个小规模），确认任务进度实时刷新、失败项可重试、作者自动进收藏且"爬主页"能建任务。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components && git commit -m "feat: 任务列表+作者收藏"
```

---

### Task 14: 内置浏览器标签 + 设置页

**Files:**
- Create: `src/renderer/src/components/BrowserPanel.tsx`
- Create: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `api.getSettings/saveSettings/testAi/showBrowser/hideBrowser`（Task 11）
- Produces: 内置浏览器提示面板、设置表单（下载目录/AI配置/并发/滚动间隔/地址TTL + 测试连接）

- [ ] **Step 1: 写浏览器面板占位（真实页面由主进程 WebContentsView 渲染）**

`src/renderer/src/components/BrowserPanel.tsx`:
```tsx
import React from 'react'

export default function BrowserPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <p className="text-lg">内置浏览器已在此标签下方显示</p>
      <p className="text-sm">首次使用请在这里扫码登录抖音，登录态会自动保存</p>
      <p className="text-xs">触发风控验证时，也在这里手动完成</p>
    </div>
  )
}
```

- [ ] **Step 2: 写设置页**

`src/renderer/src/components/SettingsPanel.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings } from '../../../shared/types'
import { Card, btnPrimary, inputCls } from './ui'

export default function SettingsPanel() {
  const [s, setS] = useState<AppSettings | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => { void api.getSettings().then(setS) }, [])

  if (!s) return <div className="text-sm text-zinc-400">加载中…</div>

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS(prev => prev ? { ...prev, [k]: v } : prev)

  async function save(): Promise<void> {
    if (!s) return
    await api.saveSettings(s)
    setMsg('已保存')
    setTimeout(() => setMsg(''), 1500)
  }

  async function testAi(): Promise<void> {
    const r = await api.testAi()
    setMsg(r.ok ? 'AI 连接正常' : `AI 连接失败：${r.error}`)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card title="下载">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          下载目录
          <input className={inputCls} value={s.downloadDir} onChange={e => set('downloadDir', e.target.value)} />
        </label>
      </Card>
      <Card title="AI 配置（OpenAI 兼容）">
        <div className="space-y-3 text-xs text-zinc-500">
          <label className="flex flex-col gap-1">
            API 地址
            <input className={inputCls} value={s.aiBaseUrl} onChange={e => set('aiBaseUrl', e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="flex flex-col gap-1">
            API Key
            <input type="password" className={inputCls} value={s.aiApiKey} onChange={e => set('aiApiKey', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            模型
            <input className={inputCls} value={s.aiModel} onChange={e => set('aiModel', e.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <button className={btnPrimary} onClick={() => void testAi()}>测试连接</button>
        </div>
      </Card>
      <Card title="运行参数">
        <div className="grid grid-cols-3 gap-4 text-xs text-zinc-500">
          <label className="flex flex-col gap-1">
            下载并发
            <input type="number" min={1} max={5} className={inputCls} value={s.downloadConcurrency} onChange={e => set('downloadConcurrency', Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            滚动间隔(ms)
            <input type="number" className={inputCls} value={s.scrollIntervalMs} onChange={e => set('scrollIntervalMs', Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            地址过期(分钟)
            <input type="number" className={inputCls} value={s.addressTtlMin} onChange={e => set('addressTtlMin', Number(e.target.value))} />
          </label>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <button className={btnPrimary} onClick={() => void save()}>保存设置</button>
        {msg && <span className="text-sm text-green-600">{msg}</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 接入 App 的 browser/settings 分支**

`src/renderer/src/App.tsx`：
```tsx
{tab === 'browser' && <BrowserPanel />}
{tab === 'settings' && <SettingsPanel />}
```
（import 两个组件）

- [ ] **Step 4: 手动验证**

Run: `npm run dev`
Expected: 设置页可保存并回读；填了真实 AI Key 后"测试连接"返回 ok；内置浏览器标签登录后，切换标签不丢登录态。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components && git commit -m "feat: 内置浏览器标签+设置页"
```

---

### Task 15: 错误处理矩阵 + 断点续传加固

**Files:**
- Create: `src/main/errors.ts`
- Test: `tests/errors.test.ts`
- Modify: `src/main/downloader.ts`
- Modify: `src/main/scheduler.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ERROR`（Task 2）
- Produces: `classifyHttpError(status: number): string`；`isRiskSignal(count: number): boolean`；`class AddressPolicy { constructor(ttlMin) ; isExpired(fetchedAt: string): boolean }`

- [ ] **Step 1: 写失败测试**

`tests/errors.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { classifyHttpError, isRiskSignal, AddressPolicy } from '../src/main/errors'
import { ERROR } from '../src/shared/types'

describe('classifyHttpError', () => {
  it('403 → forbidden', () => expect(classifyHttpError(403)).toBe(ERROR.FORBIDDEN))
  it('5xx → network', () => expect(classifyHttpError(500)).toBe(ERROR.NETWORK))
  it('200 → 空串', () => expect(classifyHttpError(200)).toBe(''))
})

describe('isRiskSignal', () => {
  it('连续3次 → true', () => expect(isRiskSignal(3)).toBe(true))
  it('少于3次 → false', () => expect(isRiskSignal(2)).toBe(false))
})

describe('AddressPolicy', () => {
  it('超过 TTL 过期', () => {
    const p = new AddressPolicy(30)
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    expect(p.isExpired(old)).toBe(true)
    expect(p.isExpired(fresh)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/main/errors.ts`:
```ts
import { ERROR } from '../shared/types'

export function classifyHttpError(status: number): string {
  if (status === 403 || status === 418) return ERROR.FORBIDDEN
  if (status >= 500 || status === 0) return ERROR.NETWORK
  return ''
}

export function isRiskSignal(count: number): boolean {
  return count >= 3
}

export class AddressPolicy {
  constructor(private ttlMin: number) {}
  isExpired(fetchedAt: string): boolean {
    const fetched = new Date(fetchedAt).getTime()
    return Date.now() - fetched > this.ttlMin * 60 * 1000
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/errors.test.ts`
Expected: PASS

- [ ] **Step 5: 加固下载器重试与过期判定**

`src/main/downloader.ts` 的 `runOne` 中，用 `classifyHttpError` 替换硬编码：
```ts
import { classifyHttpError, AddressPolicy } from './errors'

// 下载前判地址过期：
const policy = new AddressPolicy(this.settings.addressTtlMin)
if (policy.isExpired(row.fetched_at)) {
  this.db.prepare("UPDATE videos SET status='failed', error=? WHERE id=?").run(ERROR.ADDRESS_EXPIRED, id)
  this.emit({ type: 'video:status', id, status: 'failed', error: ERROR.ADDRESS_EXPIRED })
  return
}
// 网络类错误自动重试2次（利用 retry_count）：
catch (err) {
  const retry = row.retry_count + 1
  const code = classifyHttpError((err as { message?: string }).message?.startsWith('http_') ? Number((err as { message: string }).message.slice(5)) : 0) || ERROR.NETWORK
  if (retry <= 2 && code === ERROR.NETWORK) {
    this.db.prepare("UPDATE videos SET status='pending', retry_count=?, error=NULL WHERE id=?").run(retry, id)
    setTimeout(() => this.enqueue(id), 5000)
  } else {
    this.db.prepare("UPDATE videos SET status='failed', error=?, retry_count=? WHERE id=?").run(code, retry, id)
  }
  this.emit({ type: 'video:status', id, status: 'failed', error: code })
}
```

- [ ] **Step 6: 调度器风控暂停**

`src/main/scheduler.ts` 的抓取循环中，统计连续空数据轮数，配合 `isRiskSignal` 触发暂停：
```ts
import { isRiskSignal } from './errors'

// 在 emptyRounds 递增处：
emptyRounds++
if (isRiskSignal(emptyRounds) && filters.timeRange !== 'all') {
  // 保守起见：连续空数据→风控，暂停任务
  this.aborted = true
}
```
（说明：真实风控判定以"连续N轮无有效数据"为信号，不额外发探针请求。）

- [ ] **Step 7: 启动恢复逻辑已存在，补一次手动验证**

Run: `npm run dev`，跑一个任务到一半强制关闭应用，再启动。
Expected: 任务变 `paused`，pending 视频自动重新入队下载；运行中任务不重复抢跑。

- [ ] **Step 8: 提交**

```bash
git add src/main/errors.ts tests/errors.test.ts src/main/downloader.ts src/main/scheduler.ts && git commit -m "feat: 错误分类+地址过期+风控暂停"
```

---

### Task 16: 端到端验证 + 成功标准

**Files:**
- Modify: `docs/requirements.md`（验收勾选）

**Interfaces:**
- Consumes: 全部

- [ ] **Step 1: 全量单元测试**

Run: `npx vitest run`
Expected: 全部 PASS（douyin/提取/文件名/db/analyzer/downloader/scheduler/errors）

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 端到端人工验收（对照 §9 成功标准逐条）**

Run: `npm run dev`
1. 内置浏览器扫码登录抖音 → 登录态持久化
2. 管理面板填 关键词=美食, 时间=近7天, 数量=200 → 开始抓取 → 任务列表实时进度
3. 输出目录出现无水印 mp4，文件名 `标题_作者_id前8.mp4`
4. 设置页填真实 AI Key → 测试连接 ok → 开"先审后下"+规则"只要美食教程" → 任务里出现 AI已过滤 项
5. 开"下载后整理"（若已实现）→ 文件按分类归档
6. 作者自动入收藏 → 点"爬主页"能建新任务
7. 中途强关再开 → 断点续传生效
8. 提交页面滚动，观察 `aweme/v1/web/` JSON 被正确截获

- [ ] **Step 4: 验收勾选**

`docs/requirements.md` 验收标准逐条打勾，勾完向用户汇报最终状态。

- [ ] **Step 5: 提交**

```bash
git add docs/requirements.md && git commit -m "docs: 完成端到端验证"
```

---

## Self-Review 记录

**1. Spec 覆盖自查：**
- §1 目标/范围 → Task 1-2 全局约束 + Task 16 验收
- §2 架构/模块 → Task 1（脚手架）、Task 9（浏览器/挂钩）、Task 10（调度）、Task 11（IPC）
- §3 挂钩机制 → Task 9
- §4 数据流 → Task 10 调度器循环
- §5 数据模型 → Task 6
- §6 UI → Task 12/13/14
- §7 错误处理 → Task 15
- §8 技术栈 → Task 1
- §9 成功标准 → Task 16
- §10 AI → Task 7（analyzer）+ Task 10（先审后下接入）+ Task 14（设置）
- §11 适配器 → Task 2/3/11（注册表）

**2. 占位符扫描：** 无 TBD；UI 组件以真实代码给出；Task 9 的 step5/ Task 16 的 step3 是人工验证步骤（合理，非占位）。

**3. 类型一致性：** `PlatformAdapter`（Task 2）→ 被 Task 3/9/10/11 引用同名同签名；`VideoItem` 字段 Task 3 产出与 Task 6 `insertVideos` 消费一致；`Analyzer.judgeFilter(text, rule, cacheKey)` 在 Task 7 定义、Task 10/11 调用一致；`Scheduler.handleRaw` 在 Task 10 定义、Task 11 主进程调用（Task 10 步骤中注明需将该逻辑提为公开方法）。
