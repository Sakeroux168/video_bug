# 视频爬取项目完整上下文交接（交给 Claude Code）

> 生成时间：2026-09-07（Asia/Shanghai）  
> 接手对象：Claude Code  
> 仓库：`E:\视频爬取项目交接-v2\视频爬取项目交接-v2\爬取视频`  
> 当前分支：`feature/kuaishou-adapter`  
> 当前 HEAD：`3d29637 feat: parse kuaishou video feeds`  
> 工作区：干净，无未提交文件  
> 远端：`origin = https://github.com/Sakeroux168/video_bug.git`

## 0. 接手后先看这里

### 当前可用版本

员工当前应继续使用：

`E:\视频爬取项目交接-v2\视频爬取项目交接-v2\视频爬取工具-新版-2026-09-06.exe`

- 大小：`130,043,458` 字节
- SHA-256：`F73BF759CB016E7AF0C47F2BE65D1879A1E59B661F524B3CDB74439303DBAE05`
- 对应代码基线：`master` 的 `cfede9f`
- 已通过完整自动验证、打包后许可检查和隔离用户资料启动测试
- 9 月 2 日旧版仍保留，作为第二层回退

### 当前快手分支绝不能直接交付

`feature/kuaishou-adapter` 目前只完成了快手 JSON 解析器和测试夹具。它已经把“快手”注册进平台下拉框，但浏览器窗口、原始响应 IPC 和调度器接口匹配仍写死抖音。

因此当前分支会出现“界面能选快手，但实际任务无法完整工作”的半成品状态。完成本交接文档第 10 节的剩余步骤并通过全量验证前，不要打包、不要覆盖 9 月 6 日 EXE，也不要合并到 `master`。

### 接手后的第一组命令

```powershell
cd "E:\视频爬取项目交接-v2\视频爬取项目交接-v2\爬取视频"
git status --short --branch
git log --oneline --decorate -12
npm test -- --run tests/kuaishou-adapter.test.ts
npm run typecheck
```

预期：工作区干净；当前分支 HEAD 为 `3d29637`；快手适配器 13 项测试通过；类型检查通过。

---

## 1. 用户最终目标

这是一个 Electron 绿色免安装桌面工具。原本只抓抖音，现在要逐步变成多平台视频采集、筛选、下载和整理工具。

本轮总需求是：

1. 时长筛选增加“30 秒内”和用户自定义最短/最长秒数，边界包含在内。例如 10–20 秒只保留时长处于该范围的视频。
2. 下载视频时同时下载封面，封面与视频使用同一主体文件名。
3. 根据画面方向自动归入“横屏 / 竖屏 / 未识别”文件夹。
4. 任务视频列表显示评论数、作品链接，并能单独复制作品链接、复制作者名、打开原作品。
5. 所有新下载视频通过 FFmpeg 统一输出：横屏 `1920×1080`，竖屏/正方形 `1080×1920`；主体不能被拉伸。
6. 新增快手和小红书视频抓取，优先利用许可兼容的现成轮子或公开协议知识，不重复造完整浏览器/下载链。
7. 软件源码公开、可以免费自用，也允许用户利用软件处理结果赚钱，但禁止出售软件本体、换皮版、修改版、收费下载或以软件功能为主要价值的收费服务。

总设计文档：

`docs/superpowers/specs/2026-09-04-multiplatform-comments-normalization-license-design.md`

实施顺序：

1. 评论数、作品链接和复制/打开操作——已完成
2. 视频标准化与可恢复文件生命周期——已完成
3. 许可证、NOTICE、商标和发布检查——已完成
4. 快手适配器——进行中，只完成第 1 小步
5. 小红书适配器——未开始

---

## 2. 用户的协作偏好与明确授权

- 全程中文交流。
- 当前只有用户和主助手，不要调用子代理，不要把工作分派给其他 agent。
- 每进入一个任务或阶段，先告诉用户建议使用的模型和推理强度。此前格式为：`模型：Sol　Reasoning：High`。
- 用户现在倾向让助手完成全部自动测试和本机测试；不要把可自动化的验收反推给用户。
- 用户已明确允许关闭测试窗口，并以本机调试模式重启应用。
- 用户要求避免重复造轮子，优先使用成熟现有能力；但必须检查许可证，不能把非商业、无许可证、GPL/AGPL 冲突代码直接复制进项目。
- 功能实现坚持 TDD：先写测试，实际跑红，再写实现，最后跑绿。既有断言不能静默削弱或删除。
- 做完功能前不要声称“已完成”；先用实际命令验证。
- UI 改动除组件测试/构建/CSS 检查外，还要留最终人眼观感确认。自动化不能替代审美验收。
- 不要覆盖用户现有数据、旧 EXE 或下载文件。新版本应另存并保留回退。
- 当前远端比本地落后较多。没有用户明确指令前，不要擅自 push、发布 Release 或合并半成品。

模型建议：

- 平台协议、浏览器生命周期、最终审查：使用当前最高可靠模型，推理 `High` 或 `XHigh`。
- 明确测试驱动的小块 TypeScript 实现：可用工程型模型，推理 `High`。
- 最终全量回归和发版裁决：使用最高可靠模型，推理 `XHigh`。

---

## 3. Git 和分支状态

### 当前提交关系

```text
3d29637 (HEAD -> feature/kuaishou-adapter) feat: parse kuaishou video feeds
c527378 docs: plan kuaishou adapter
cfede9f (master) docs: record normalization and license release gate
d66aaac feat: show source available license in help
6cdc949 chore: add source available license compliance
80eba1b docs: plan license and release compliance
50a81c8 feat: manage original videos with final output
dcf7867 feat: normalize downloads before completion
b40246a feat: add video normalization settings
3f045c0 feat: normalize videos with ffmpeg
a6cc2c7 feat: define video normalization policy
f037780 docs: plan ffmpeg video normalization
36ab2e6 feat: show comments and source actions
4400bdb fix: preserve unknown comment counts
f0aff89 feat: open source videos through safe ipc
08b2061 feat: persist video comments and source urls
e11b9f5 feat: capture comments and source links
5a484e8 docs: plan comments and source links
44e8c97 docs: design multiplatform video workflow
da98541 fix: harden paired downloads and duration boundaries
9e5ac2c feat: organize downloads by orientation
5706c30 feat: download paired video covers
896fe75 feat: persist cover and video dimensions
c5fba48 feat: add custom duration filtering
...
6646f0a (origin/master) docs: 上下文交接文档（第十七轮 P0-P3 完成，P4 待做）
```

当前分支相对 `origin/master` 多 28 个提交。`master` 相对 `origin/master` 多 26 个提交。当前功能分支相对 `master` 只有两个快手提交。

注意两种“P4”不要混淆：

- 旧交接文档里的 UI P4 已由 `41dded4` 完成。
- 当前多平台总路线的第 4 阶段是“快手适配器”，尚未完成。

### 远端

```text
origin  https://github.com/Sakeroux168/video_bug.git
bundle  E:/视频爬取项目交接-v2/视频爬取项目交接-v2/爬取视频.bundle
```

### Git 安全要求

- 开始改动前总是先看 `git status --short --branch`。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令清理用户工作。
- 每个可独立验证的小阶段单独提交。
- 快手完成后先在功能分支全量验证，再快进合并 `master`；不要把未通过在线烟测的分支直接当正式发版。
- push、Release、覆盖交付文件都应先向用户说明。

---

## 4. 技术栈、运行方式和数据位置

### 技术栈

- Electron 35.7.5
- 内置 Node 22.x，项目使用实验性 `node:sqlite`
- React 18 + TypeScript + Tailwind 3.4
- electron-vite 3
- Vitest + Testing Library + jsdom
- electron-builder 26，Windows x64 portable
- FFmpeg / ffprobe 8.0.1 随包
- sherpa-onnx-node 1.13.4 用于可选 ASR

### 关键脚本

```powershell
npm run dev
npm run typecheck
npm test
npm run build
npm run check:css
npm run check:licenses
npm run verify
npm run dist
npm run check:packaged-licenses
```

`npm run verify` 当前顺序是：类型检查 → 全量测试 → 生产构建 → CSS 检查 → 源码许可检查。

### 打包机 FFmpeg

`electron-builder.yml` 当前写死：

`E:/123/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe`  
`E:/123/ffmpeg-8.0.1-essentials_build/bin/ffprobe.exe`

换机器打包时必须同步调整，或者先把构建规则改成可靠的可配置路径。不要从未知站点临时下载二进制后直接发版。

### 为什么 EXE 不需要安装

打包目标是 electron-builder 的 `portable`。EXE 自解压/加载内置运行时，因此双击即可运行，不需要安装器；这不代表它没有配置或数据库。

### 用户数据继承

`electron-builder.yml` 刻意不设置 `productName`，应用名保持 `video-scraper`，因此普通启动使用同一目录：

`%APPDATA%\video-scraper`

其中主要有：

- `scraper.db`：任务、作者、视频、状态、路径
- `settings.json`：设置
- `Partitions\douyin`：抖音登录态
- 后续应新增 `Partitions\kuaishou` 和 `Partitions\xiaohongshu`
- `asr-models`：本地语音识别模型

删除旧版 EXE不会删除这些数据；新版普通双击会继承。但不要删除 `%APPDATA%\video-scraper` 或下载目录，也不要同时运行多个版本写同一数据库。

`initDb()` 使用 `PRAGMA table_info + ALTER TABLE ADD COLUMN` 增量迁移旧库，现已兼容新增封面、宽高、作品链接、原片路径和标准化错误列。

---

## 5. 当前架构和关键文件

主链：

```text
平台浏览器/适配器
  → VideoItem
  → filterVideos / dedupeVideos
  → SQLite
  → Downloader
  → VideoNormalizer
  → Organizer
  → 品类/作者/横竖屏/时长目录
```

关键文件：

```text
src/main/index.ts                 主进程装配、原始响应日志、浏览器/调度器/下载器
src/main/browser.ts               内置平台浏览器；目前仍是抖音专用窗口
src/main/injector.ts              注入 fetch/XHR 拦截；消息名仍是 dy:raw
src/preload/douyin.ts             页面消息转 IPC；仍只接受 dy:* 
src/main/scheduler.ts             任务循环、筛选、入库、停滞自救；接口匹配仍写死抖音路径
src/main/adapters/types.ts        PlatformAdapter 与统一 VideoItem 契约
src/main/adapters/douyin.ts       抖音适配器
src/main/adapters/kuaishou.ts     新增，当前只完成解析/URL 层
src/main/adapters/index.ts        适配器注册表；当前已注册 douyin + kuaishou
src/main/downloader.ts            下载、封面、断点、标准化、失败恢复
src/main/videoNormalizer.ts       ffprobe + FFmpeg 标准化
src/main/organizer.ts             品类/作者/横竖屏/一分钟内外归档
src/main/videoSource.ts           原作品 URL 白名单校验
src/main/ipc.ts                   任务、作者、视频、设置等 IPC
src/main/db.ts                    表结构、旧库迁移与查询
src/main/settings.ts              默认设置与持久化
src/renderer/src/App.tsx          左侧导航和页面装配
src/renderer/src/components/FilterForm.tsx
src/renderer/src/components/TaskList.tsx
src/renderer/src/components/SettingsPanel.tsx
src/renderer/src/components/HelpPanel.tsx
scripts/check-css.mjs
scripts/check-licenses.mjs
electron-builder.yml
```

统一 `VideoItem` 当前字段：

```ts
interface VideoItem {
  awemeId: string
  title: string
  authorSecUid: string
  authorNickname: string
  authorHomeUrl: string
  playUrl: string
  coverUrl: string
  width: number
  height: number
  durationSec: number
  publishTime: number
  likes: number
  comments: number | null
  sourceUrl: string
}
```

数据库物理列仍叫 `aweme_id` / `play_addr`，为了旧库兼容暂不改名。跨平台唯一键是 `UNIQUE(platform, aweme_id)`。

---

## 6. 已完成：时长、封面、横竖屏

相关提交：

- `c5fba48 feat: add custom duration filtering`
- `896fe75 feat: persist cover and video dimensions`
- `5706c30 feat: download paired video covers`
- `9e5ac2c feat: organize downloads by orientation`
- `da98541 fix: harden paired downloads and duration boundaries`

功能事实：

- 时长新增 `under30` 和 `custom`。
- 自定义最短/最长必须是正整数且最大值不小于最小值。
- 时长判断保留精确秒数，包含上下边界；10–20 不会把 20.4 秒错误取整成 20。
- 下载视频后尝试下载同名封面；封面失败不毁掉已成功视频。
- 重名时视频和封面共用同一新主体名。
- `height >= width` 归竖屏，`width > height` 归横屏；缺尺寸时 ffprobe，仍失败归未识别。
- 归档结构继续包含“一分钟内 / 一分钟外”。
- 已归档旧视频不会自动迁移，也不会自动补旧封面。
- 程序内删除视频会同步删除受管理目录里的配对封面。

9 月 2 日验收：58 个测试文件、553 项测试通过；真实 ffmpeg/ffprobe 横屏、竖屏、正方形样本通过。

详见：`docs/验收记录-2026-09-02-时长封面横竖屏.md`

---

## 7. 已完成：评论数和作品链接

相关提交：

- `5a484e8 docs: plan comments and source links`
- `e11b9f5 feat: capture comments and source links`
- `08b2061 feat: persist video comments and source urls`
- `f0aff89 feat: open source videos through safe ipc`
- `4400bdb fix: preserve unknown comment counts`
- `36ab2e6 feat: show comments and source actions`

功能事实：

- 抖音评论数来自 `statistics.comment_count`。
- 评论真实 0 显示 0；缺失/非法为 `null`，界面显示 `—`，不能把未知伪装成 0。
- 评论列支持排序。
- `source_url` 保存作品页，不保存易过期 CDN 地址。
- 旧记录没有 `source_url` 时由适配器根据平台和作品 ID 生成。
- 行内可“打开原视频 / 复制链接 / 复制作者名”。
- 打开原作品前必须是 `https:` 且主机在当前平台白名单，污染数据库里的外域/恶意协议会被拒绝。
- 操作按钮不会破坏行选择、多选和框选。

相关计划：`docs/superpowers/plans/2026-09-04-comments-source-links.md`

---

## 8. 已完成：FFmpeg 标准化与恢复

相关提交：

- `f037780 docs: plan ffmpeg video normalization`
- `a6cc2c7 feat: define video normalization policy`
- `3f045c0 feat: normalize videos with ffmpeg`
- `b40246a feat: add video normalization settings`
- `dcf7867 feat: normalize downloads before completion`
- `50a81c8 feat: manage original videos with final output`

输出规则：

- 横屏：`1920×1080`
- 竖屏/正方形：`1080×1920`
- 识别旋转元数据后按显示方向决定横竖
- 已是目标尺寸、H.264、yuv420p、方形像素、MP4、音频为 AAC/无音频时跳过重编码

画面策略不是硬拉伸：

- 前景：完整等比缩放后居中，不裁主体
- 背景：同源画面等比铺满、居中裁切、低工作分辨率模糊后放大
- 最终 `setsar=1`、`yuv420p`

编码：

- `libx264 -preset medium -crf 20`
- AAC 192 kbps；无音轨正常
- `-movflags +faststart`
- 清旋转元数据

文件生命周期：

- 原始下载断点：`.video-{id}.download.part.mp4`
- 标准化临时文件：`.video-{id}.normalized.part.mp4`
- 源文件验证通过后才把断点写进数据库
- 转码成功并复验尺寸、编码、文件大小、时长后才改成最终 MP4
- 转码失败时保留已验证源视频作为最终视频，并记录 `normalization_error`
- 暂停发生在转码阶段会保留已验证断点，继续后不重复请求 CDN
- 取消会清临时文件
- 可选保留 `${主体名}.original.mp4`
- 成品、封面、原片同组归档、重名、回滚、重试和删除
- 文件统计只计算成品，不重复统计 `.original.mp4`

设置默认值：

- `normalizeVideo: true`
- `keepOriginalVideo: false`

相关计划：`docs/superpowers/plans/2026-09-05-video-normalization.md`

---

## 9. 已完成：许可和发布检查

相关提交：

- `80eba1b docs: plan license and release compliance`
- `6cdc949 chore: add source available license compliance`
- `d66aaac feat: show source available license in help`
- `cfede9f docs: record normalization and license release gate`

主项目许可：`MIT License + Commons Clause License Condition v1.0`。

准确说法是“源码可用 / Source Available”，不能宣传为 OSI 标准开源。

用户要求的含义：

- 可以免费个人使用、公司内部使用、查看和修改源码。
- 可以用软件处理自己有权处理的内容，并靠输出成果赚钱。
- 禁止卖软件本身、换皮版、修改版、收费下载、出租或以软件功能为主要价值的收费托管服务。

法律文件：

- `LICENSE`
- `LICENSE.zh-CN.md`
- `NOTICE`
- `TRADEMARKS.md`
- `third_party/licenses/`

随包许可：FFmpeg GPLv3 和精确构建信息、Electron/React MIT、Apache 2.0。`scripts/check-licenses.mjs` 检查源码材料、直接运行依赖许可和打包后的 9 份文件。

重要事实：随包 FFmpeg 8.0.1 启用了 `--enable-gpl --enable-version3 --enable-libx264`，因此按 GPLv3 分发；它是独立 EXE，由程序调用，不被项目许可重许可。

正式公开发布或遇到收费服务边界时仍建议律师复核。现有文档不是法律意见。

---

## 10. 正在进行：快手适配器

计划：`docs/superpowers/plans/2026-09-06-kuaishou-adapter.md`

### 已完成

提交 `3d29637` 新增：

- `src/main/adapters/kuaishou.ts`
- `tests/kuaishou-adapter.test.ts`
- 在 `src/main/adapters/index.ts` 注册 `kuaishou`

当前实现能力：

- 平台名：`kuaishou` / 显示名“快手”
- 登录分区声明：`persist:kuaishou`（但浏览器尚未实际采用）
- 搜索页：`https://www.kuaishou.com/search/video?searchKey={关键词}`
- 作者页：`https://www.kuaishou.com/profile/{userId}`
- 作品页：`https://www.kuaishou.com/short-video/{photoId}`
- GraphQL 地址特征：`/graphql`
- 解析搜索 `visionSearchPhoto`
- 解析作者列表 `visionProfilePhotoList`
- 解析详情 `visionVideoDetail`
- 标题 `caption → originCaption`
- 作者 `author.id/name`
- 播放地址优先 `photoUrl`
- `photoUrl` 缺失时，从 `videoResource.json` 中选择 H.264 最高码率/分辨率，再回退 HEVC
- 支持 `videoResource.json` 是对象或 JSON 字符串
- 封面 `coverUrl → coverUrls[0].url`
- 时长毫秒转秒
- 13 位时间戳毫秒转 Unix 秒，10 位秒时间戳保留
- 点赞/评论支持数字、数字字符串和“万/w”简写
- 真实 0 评论保留，未知为 `null`
- 作者完整 URL和裸 ID解析
- `v.kuaishou.com` / `c.kuaishou.com` 短链接识别后拒绝，不静默猜作者 ID
- 过滤缺作品 ID、播放地址或作者 ID 的条目

已实际运行：

```text
npm test -- --run tests/kuaishou-adapter.test.ts
13 tests passed

npm run typecheck
passed
```

### 当前已知缺口和风险

1. `src/main/browser.ts` 创建窗口时仍写死：
   - `title: '抖音浏览器'`
   - `partition: 'persist:douyin'`
   - preload 为 `../preload/douyin.js`

2. `src/main/injector.ts` 仍发 `{ type: 'dy:raw' }`，并用 `window.__dyHookInstalled`。

3. `src/preload/douyin.ts` 只转发 `dy:*`，IPC channel 是 `dy:raw` / `dy:scroll-abort`。

4. `src/main/index.ts` 的 `ipcMain.on('dy:raw')` 和构造 `VideoBrowser` 的回调都写死 `douyinAdapter`。构造器里的 `onRaw` 参数事实上没有被使用，可以删除或真正接通，不能继续让它造成“看起来已泛化”的错觉。

5. `src/main/scheduler.ts::matchesTaskEndpoint()` 写死抖音接口：
   - keyword → `/search/`
   - author → `/aweme/post/`
   - hashtag → `/challenge/` 或 `/search/`

   快手所有业务都走同一个 `/graphql`，必须根据响应根字段或 operation 信息区分：

   - keyword / hashtag → `visionSearchPhoto`
   - author → `visionProfilePhotoList`
   - detail 当前没有独立 TaskType；解析器可以兼容，但不要让用户手动点击的无关详情响应污染当前任务。

6. 当前计划写了“宽高可回退 `videoRatio`”，但 `3d29637` 代码尚未实现 `videoRatio` 回退，测试也没有覆盖。应先明确真实字段格式，再补红绿测试；无法可靠推导时宁可宽高为 0，下载后让 ffprobe 判断，不要伪造尺寸。

7. 当前 `VideoBrowser` 单窗口架构需要按平台切换分区。推荐做法：

   - `load(adapter, url)` 前调用 `ensureWindow(adapter)`。
   - 当前窗口的 `sessionPartition` 与目标不同时，安全销毁旧窗口并用新适配器重建。
   - 分区名持久化，所以销毁窗口不会删除平台 Cookie；切回抖音仍用 `persist:douyin`。
   - 相同平台连续任务不重建窗口。
   - `setVisible`、滚动、验证码、读昵称、开发者工具都只操作当前活动窗口。
   - 平台切换时正确处理 `forceClose`、`positioned`、`everShown`，避免 close 事件把销毁变成 hide。

8. 作者昵称清洗 `readAuthorNickname()` 只剥“抖音”后缀；应由活动适配器提供站点名，或改为平台无关且有测试的规则。

9. `FilterForm` 作者输入 placeholder 仍是抖音 URL；创建失败提示仍写“未识别到抖音主页链接或作者 ID”。要跟随平台显示。

10. `TaskList` 目前直接显示 `{t.platform}/{t.type}`，快手应显示中文名或集中格式化。

11. `authors:import` IPC 和作者批量导入 UI仍固定抖音。快手第一版如果不支持批量导入，界面要明确；如果支持，必须让每条作者带平台，不能拿快手 URL交给抖音解析器。

12. 下载 Referer 当前是 ``https://www.${row.platform}.com/``。对 `kuaishou` 恰好得到正确主页，但平台知识最好集中到适配器，避免未来小红书/国际域名/特殊主机失效。

13. 原始响应日志变量和界面文案大量叫 `dy:raw` / “抖音”。泛化时要保留兼容性测试，日志中不得打印 Cookie、签名、完整响应正文。

14. 在线接口可能改版。固定测试只能证明我们的解析逻辑，不能证明今天的快手页面一定仍返回该结构。完成后必须做一次受控浏览器烟测。

### 精确后续步骤

#### A. 平台化任务接口匹配（先做）

建议给 `PlatformAdapter` 增加：

```ts
matchesTaskResponse(type: TaskType, url: string, json: unknown): boolean
```

抖音把现有 `matchesTaskEndpoint()` 规则原样搬进适配器；快手检查 GraphQL 响应中的 `visionSearchPhoto` / `visionProfilePhotoList`。然后删除 scheduler 里的抖音硬编码。

测试先行：

- 抖音 keyword/author/hashtag 规则不回退。
- 快手 keyword/hashtag 只接受搜索响应。
- 快手 author 只接受作者作品列表。
- 推荐流/详情响应不污染其他任务。

#### B. 泛化注入与 IPC

- 消息名改为平台无关，如 `platform:raw` / `platform:scroll-abort`。
- preload 改成通用文件，例如 `src/preload/platform.ts`，同步调整 `electron.vite.config.ts`。
- 主进程从当前活动浏览器拿适配器，再调用 `scheduler.handleRaw(adapter, url, json)`。
- 不要仅凭 URL遍历全部适配器；快手/未来平台可能共用 `/graphql` 这样的通用路径。
- 增加 injector 测试，原测试目前逐字断言 `dy:raw`，应在实际泛化设计确定后等强度迁移，不能删掉拦截 fetch、XHR text、XHR json、重复安装等覆盖。

#### C. 平台浏览器生命周期

- 写 BrowserWindow mock 测试，先让测试红。
- 验证首次快手任务使用 `persist:kuaishou`、标题“快手浏览器”。
- 验证同平台重复 load 不重建。
- 验证抖音 → 快手 → 抖音时创建分区顺序正确，且旧窗口被销毁而不是隐藏残留。
- 确保任务运行时的窗口显隐优先级逻辑不变。

#### D. IPC、UI 和下载细节

- 作者输入错误按平台显示。
- FilterForm placeholder 跟平台。
- 平台显示名集中，不散落 `platform === ...`。
- `resolveVideoSourceUrl` 已自动使用注册适配器白名单；为快手补测试，恶意外域仍拒绝。
- Downloader 至少补快手 Referer 测试。
- 确认封面、标准化、横竖屏归档不需要平台分支。

#### E. 验证和发版

```powershell
npm test -- --run tests/kuaishou-adapter.test.ts
npm test -- --run tests/injector.test.ts tests/browser.test.ts tests/scheduler.test.ts
npm run typecheck
npm test
npm run build
npm run check:css
npm run check:licenses
npm run verify
```

在线烟测：

1. 以调试模式启动。
2. 创建快手关键词任务。
3. 确认打开的是“快手浏览器”，资料分区是 `persist:kuaishou`。
4. 如需登录/验证码，只让用户手工完成，不绕过。
5. 查看原始响应日志：确认命中 `/graphql`，解析数和保留数合理。
6. 验证至少 1 条视频入库，标题、作者、点赞、评论、封面、作品链接正确。
7. 下载 1 条，确认媒体可用、封面同名、FFmpeg 输出尺寸正确、横竖屏归档正确。
8. 暂停/继续/取消各做一次低风险烟测。

只有以上通过后再 `npm run dist`、检查打包许可、用隔离 `--user-data-dir` 启动便携 EXE，并生成新日期文件名。不要覆盖 9 月 6 日稳定 EXE。

---

## 11. 社区调研结论（快手）

### 已确认的公开行为

- 网页 GraphQL：`https://www.kuaishou.com/graphql`
- 常见操作：`visionSearchPhoto`、`visionVideoDetail`、`visionProfilePhotoList`
- 常见字段：`photo.id/duration/caption/originCaption/likeCount/commentCount/coverUrl/photoUrl/videoResource/timestamp/videoRatio`，Feed 同级有 `author.id/name`
- 搜索页：`https://www.kuaishou.com/search/video?searchKey=...`
- 作者页：`https://www.kuaishou.com/profile/{userId}`
- 规范作品页：`https://www.kuaishou.com/short-video/{photoId}`
- 官方开放平台的视频字段也包含 `photo_id/caption/cover/play_url/create_time/like_count/comment_count`，但其接口需要 app_id、access_token 和授权 scope，只适合授权用户内容，不作为公开页面抓取主链。

### 仓库与许可判断

1. MediaCrawler  
   `https://github.com/NanmiCoder/MediaCrawler`

   许可证是 `NON-COMMERCIAL LEARNING LICENSE 1.1`，仅限非商业学习/研究并限制商业用途和大规模抓取。可以用来核对公开行为和异常场景，但不要复制源码进入本项目。

2. QMediaCrawler  
   `https://github.com/QiCodeCN/QMediaCrawler`

   是 MediaCrawler fork；不要因为 fork 页面没有清楚显示许可证就当 MIT。当前仅把公开 GraphQL 字段名当兼容性线索，不复制查询文件或实现。

3. videodl  
   `https://github.com/CharlesPikachu/videodl`

   当前许可为 PolyForm Noncommercial 1.0.0；不能复制代码。其对 `window.__APOLLO_STATE__` 和 `videoResource` 的观察只作为行为线索。

4. agent-reach-plus  
   `https://github.com/xuanbingbingo/agent-reach-plus`

   README 声称继承 MIT，但当时未能可靠拉到原始 LICENSE。许可证未确认前，不复制实现或完整 GraphQL 查询体。

5. 官方快手开放平台  
   `https://open.kuaishou.com/`

   可用来确认字段语义、作品 URL形式和时间戳单位；不应把需要 OAuth 的官方 API误当成可抓任意公开内容的接口。

### 采用原则

- 当前 `kuaishou.ts` 是本项目独立 TypeScript 实现，不复制上述受限仓库代码。
- 字段名和公开 URL/接口行为不等于复制代码，但具体实现、完整查询文档、注释和测试必须由本项目自行编写。
- 若后续引入任何第三方包或源文件，先固定仓库提交、核对 LICENSE、登记 NOTICE、增加许可测试。

---

## 12. 未开始：小红书适配器

快手完整验收前不要同时开小红书，避免平台生命周期改两遍。

已批准范围：

- 关键词搜索
- 作者主页/作者 ID
- 作品详情
- 只收视频笔记；纯图文跳过并给诊断，不计入目标数量
- 独立 `persist:xiaohongshu`
- 使用页面自身会话产生的 `X-s / X-t / xsec_token` 等能力；renderer 不保存、不拼签名
- 去重用稳定笔记 ID，不用可能过期的 `xsec_token`
- 作品打开链接可带必要公开查询参数，但不能把短期 token 当永久身份

优先调研候选：

- `xiaohongshu-mcp`（此前设计阶段记录为 Apache-2.0，接手时必须重新核对当前 LICENSE 和固定 commit）
- `Openweb`（此前记录为 MIT，同样重新核对）

仍然不要复制 MediaCrawler 的非商业许可代码。

建议在快手完成后先写独立计划：

`docs/superpowers/plans/2026-09-xx-xiaohongshu-adapter.md`

---

## 13. 测试和验收基线

### 9 月 6 日稳定基线

- `npm run verify` 退出码 0
- 64 个测试文件
- 629 项测试全部通过
- 主进程和渲染进程 TypeScript 通过
- 生产构建通过
- CSS：47 个关键类存在，5 个旧类已清除
- 源码许可检查通过
- `npm run dist` 通过
- 打包后 9 份许可材料检查通过
- 便携 EXE 使用隔离资料成功启动并建立 `scraper.db`
- 测试后 QA 应用进程为 0

真实 FFmpeg 测试覆盖：

- 横屏
- 竖屏
- 正方形
- 4:3
- 超宽
- 低分辨率
- 无音频
- 旋转元数据

### 当前快手分支已验证

- 快手适配器 13 项测试通过
- `npm run typecheck` 通过
- 交接前已在当前 `3d29637` 代码上运行完整 `npm run verify`，退出码 0
- 当前分支共 65 个测试文件、642 项测试全部通过
- 当前分支生产构建、CSS（47 个关键类/5 个旧类）和源码许可检查通过
- 尚未做快手线上登录/GraphQL/下载烟测
- 尚未生产新 EXE

### 当前仍需人工确认的视觉项

- 9 月 6 日“使用说明”里的许可卡片做过 DOM、构建和 CSS 自动验证，但最终视觉观感仍待用户打开看一眼。
- 快手 UI 完成后同样需要最终人眼验收。

---

## 14. 当前软件的其他现有能力

这些并非本轮新增，但后续不能破坏：

- 左侧导航 + 概览首页
- 关键词、作者、话题三类任务
- 目标数量 1–1000
- 时间范围和时长筛选
- 自动下载 / 手动挑选
- 允许/禁止重复抓取已完成作者主页
- AI“先审后下”
- 下载后按作者自动整理
- 可选 ASR + AI 视听分类
- 下载并发、滚动速度、每页等待、停滞阈值、重搜冷却可配置
- 全局和单视频暂停/继续/取消
- 下载失败重试
- 任务停滞自动重搜，最多 3 次后暂停
- 验证码识别后暂停等人工处理，不绕过
- 作者导入后的“名称强绑定链接”校验
- 作者、任务、文件管理和程序内删除
- 重启恢复 pending/downloading 状态
- 文件路径安全检查
- 原始响应和停滞自救日志
- 内置浏览器窗口显隐不应抢用户焦点

旧交接文档 `docs/上下文交接-2026-08-18.md` 记录了更早 UI 重构、停滞自救和大量历史红线。遇到旧模块问题时可参考，但其中“当前分支/测试数/P4 未完成”等状态已过期，以本文件为准。

---

## 15. 重要安全、稳定性和发布红线

1. 不绕过验证码，不做账号池、代理池或高并发轰炸。
2. 只抓公开内容；用户负责版权、隐私、平台规则和所在地法律。
3. 不在日志打印 Cookie、签名、token 或完整响应体。
4. 不信任数据库中的作品 URL；打开外部链接始终走适配器白名单。
5. 不用简单 `scale=1920:1080` / `1080:1920` 拉伸主体。
6. FFmpeg 失败不能丢掉已经验证成功的源视频。
7. 程序删除文件时只删除受管理下载目录内经安全校验的明确路径。
8. 不自动搬迁已归档旧视频，不自动给旧视频补转码或补封面。
9. 不同时运行旧版和新版写同一 `%APPDATA%\video-scraper` 数据库。
10. 打包前必须跑许可检查；新增依赖必须登记许可证。
11. 不把当前 Commons Clause 项目宣传为 OSI 开源。
12. 不覆盖稳定 EXE；新版本用新日期命名，先隔离资料启动，再交付。
13. 页面接口字段是易变外部契约。解析失败要明确诊断，不要静默显示“抓到 0 条”让用户误以为没有内容。
14. Tailwind 类名不要动态拼接；`scripts/check-css.mjs` 是防产物 purge 的金丝雀。

---

## 16. 建议 Claude Code 的执行顺序

1. 阅读本文件。
2. 阅读快手计划和总设计，不必从头重做需求讨论。
3. 确认 Git 状态和 HEAD，没有意外工作再改。
4. 先补 `matchesTaskResponse` 测试和实现。
5. 再泛化 injector/preload/IPC。
6. 再做按平台分区的 BrowserWindow 生命周期。
7. 再改 UI 文案、作者输入、平台显示、下载 Referer。
8. 运行定向测试和全量 `npm run verify`。
9. 手工控制内置浏览器做真实快手烟测，不处理验证码。
10. 做代码审查，重点查半成品暴露、任务串流、窗口销毁、Cookie 分区、日志敏感信息、旧抖音回归。
11. 通过后构建新 portable，检查打包许可和隔离启动。
12. 写新的验收记录，再向用户申请是否合并 `master`、push 和交付。

如果快手真实页面与固定夹具不一致：先记录脱敏字段名和响应根结构，更新测试到红，再改解析器。不要直接在生产路径里堆没有测试的猜测分支。

---

## 17. 给 Claude Code 的开场指令

可直接把下面这段作为新会话第一条任务：

```text
请接手 E:\视频爬取项目交接-v2\视频爬取项目交接-v2\爬取视频。
先完整阅读 docs\上下文交接-2026-09-07-ClaudeCode.md、
docs\superpowers\plans\2026-09-06-kuaishou-adapter.md 和
docs\superpowers\specs\2026-09-04-multiplatform-comments-normalization-license-design.md。

严格停留在 feature/kuaishou-adapter 分支，先核对 git status 和 HEAD=3d29637，
不要覆盖 2026-09-06 稳定 EXE，不要 push，不要发布，不要调用子代理。

按 TDD 继续快手阶段：先把任务接口匹配下沉到 PlatformAdapter，保留抖音规则，
再泛化原始响应通道和按平台登录分区的 VideoBrowser，最后补 UI/IPC/下载细节。
每个阶段先告诉我建议模型和推理强度；先跑红测试，再实现，再跑绿。
所有自动测试和本机烟测由你执行，验证码只提示人工处理，不绕过。
完成前必须跑 npm run verify、真实快手烟测、打包许可检查和隔离资料启动；
没有证据不要宣称完成。
```

---

## 18. 交接结论

当前稳定产品功能已覆盖：自定义时长、封面、横竖屏、评论数、原作品链接、FFmpeg 无拉伸标准化、可恢复下载生命周期、原片管理和源码可用许可发布检查。

快手阶段已经完成独立解析器和 13 项测试，但整个运行链尚未接通。当前最重要的不是继续扩展字段，而是把“抖音写死的浏览器/IPC/调度匹配”正确泛化，并证明抖音不回退。完成快手后再开始小红书。
