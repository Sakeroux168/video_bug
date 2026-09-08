# 小红书适配器实施计划

> **执行方式：** 按任务逐条推进，先写测试再写实现，每个检查点实际跑命令验证。本项目不使用子代理。

**目标：** 让小红书支持关键词、话题与作者主页三种任务，抓到视频笔记并下载、转码、归档，与抖音/快手同一条流水线收尾。

**与前两个平台的根本差异：** 抖音与快手的搜索列表直接给播放地址，拿到就能下。小红书的搜索列表**只给卡片**（标题、封面、作者、互动数），播放地址只存在于笔记详情里。因此流水线要多一个「详情解析」阶段。

**真机取证（2026-09-08）：** 全部结论来自用户本机的拦截日志与两次响应抓取，不采信公开资料。快手那一轮的教训是照公开资料写完解析器、真机一跑发现平台早换了传输方式。

## 实测接口

| 用途 | 接口 | 说明 |
|---|---|---|
| 关键词搜索 | `so.xiaohongshu.com/api/sns/web/v2/search/notes` | 日志里是协议相对 URL（`//so.xiaohongshu.com/...`），匹配规则必须能认这种形态 |
| 笔记详情 | `edith.xiaohongshu.com/api/sns/web/v1/feed` | 由页面自己发起；需要 `xsec_token` 与 Cookie 签名，我们不生成也不代发 |
| 作者主页 | **未取证** | 接入作者任务前必须先抓一次，不得照搜索接口推测 |

搜索页地址实测为 `https://www.xiaohongshu.com/search_result_ai?keyword=<双重编码>&source=unknown`。
`keyword` 是二次编码（`%25E7%25BE%258E` 解一次才是 `%E7%BE%8E`）。骨架里原写的 `search_result` 是错的，要一并改正。

## 实测响应结构

### 搜索列表

```
{ code, success, msg, data: { items: [...], has_more, request_dqa_instant } }
items[i]: { id, model_type: 'note' | 'hot_query', xsec_token, note_card? }
note_card: { type: 'normal' | 'video', display_title, cover{url_default,url_pre,w,h},
             image_list[], user{user_id,nickname,avatar,xsec_token},
             interact_info{liked_count,comment_count,collected_count,shared_count},  // 全是字符串
             corner_tag_info[{type:'publish_time', text:'2天前'|'07-03'|'2025-10-20'}] }
```

- `model_type='hot_query'` 是「大家都在搜」推荐词，必须跳过
- 列表**没有播放地址、没有时长**；发布时间只有给人看的字符串
- 「只看视频」筛选**不体现在网址里**，重新打开就丢失

### 笔记详情

```
data.items[0].note_card: {
  note_id, title, desc, type:'video', time: 1763540281000,   // 13 位毫秒
  user{user_id,nickname,avatar,xsec_token},
  interact_info{liked_count,comment_count,collected_count,share_count},
  tag_list[{type:'topic',id,name}],
  video: {
    media_v2: "<整个 media 的 JSON 字符串副本>",
    media: { video_id, video{duration:276, stream_types[], md5, drm_type},
             stream: { EF4:[...], EF5:[...], EF6:[], EF7:[] } },
    capa: { duration: 275 }
  }
}
stream 各档: { stream_type, width, height, duration(ms), size, avg_bitrate,
              video_codec:'EF4'|'EF5', audio_codec:'aac', format:'mp4',
              master_url: "...?sign=...&t=<hex 到期时间>", backup_urls: [无签名] }
```

实测样本：EF4 一档 720×1280；EF5 四档 720/1080/1440/**2160×3840（212 MB）**。
`t=6aa455a6` 换算后约 3.7 天有效，宽于现有 `addressTtlMin` 默认 30 分钟。

## 不变量

- **不生成、不代发签名请求。** 详情一律靠导航到笔记页、由页面自己请求，我们旁听。
- **`xsec_token` 是一次性短期令牌，不落库。** 只在同一次任务的内存里用掉。存库的 `source_url` 用不带 token 的干净作品页地址。
- **只收 `type='video'` 的笔记。** 图文跳过并计入诊断，不计入目标数量。
- **不靠 DOM 类名点按钮。** 小红书类名是哈希的，与抖音同一个坑；筛选在解析层做。
- 详情解析失败的笔记整条丢弃，不入库一个点不开的视频；失败要有可读诊断。
- 每条视频一次页面导航，必须限流并可被暂停/取消打断，与既有任务状态机一致。
- 抖音与快手行为零回退。

## 任务拆解

### 任务 1：修正骨架里的页面地址与搜索列表解析

**文件：** `src/main/adapters/xiaohongshu.ts`、`tests/xiaohongshu-adapter.test.ts`

- [ ] 夹具照实测响应手写（字段名与层级一比一，值全部编造）
- [ ] `buildSearchUrl` 改为 `search_result_ai` + 正确编码；与实测地址比对
- [ ] `apiUrlPatterns` 加 `/api/sns/web/v2/search/notes`，能匹配协议相对 URL
- [ ] `matchesTaskResponse`：关键词/话题认搜索响应；作者任务此阶段仍返回 false
- [ ] 列表解析产出**笔记存根**（id + xsec_token + 卡片信息），跳过 `hot_query` 与 `type!=='video'`
- [ ] 跑红 → 实现 → 跑绿
- [ ] 提交：`feat: parse xiaohongshu search notes`

### 任务 2：详情响应解析（纯函数，先不接流水线）

**文件：** `src/main/adapters/xiaohongshu.ts`、`tests/xiaohongshu-adapter.test.ts`

- [ ] 夹具照实测详情响应手写
- [ ] 从 `video.media.stream` 各档中选播放地址：**优先 EF4**（编码兼容性未知时更保守），其次 EF5；
      在 EF5 内按分辨率挑选，**排除 2160p**（单条 200 MB 级，转码代价过高）
- [ ] `master_url` 取不到时回落 `backup_urls`
- [ ] 时长取 `capa.duration` → `media.video.duration` → stream 的毫秒时长
- [ ] 发布时间取 `time`（13 位毫秒 → 整秒）
- [ ] 评论数取 `interact_info.comment_count`；字符串数字与「万」后缀都要认；未知为 null
- [ ] 一档播放地址都取不到 → 整条丢弃
- [ ] 提交：`feat: parse xiaohongshu note detail`

### 任务 3：调度器增加详情解析阶段

**文件：** `src/main/scheduler.ts`、`src/main/browser.ts`、`tests/scheduler.test.ts`

- [ ] 先写失败测试：搜索阶段只收存根不入库；详情阶段逐条导航并入库；暂停/取消能在详情阶段中断
- [ ] 搜索阶段收集存根到内存（含 `xsec_token`），达到目标数量或到底后停止滚动
- [ ] 详情阶段：逐条 `browser.load(adapter, 详情页地址)`，等待该笔记的 feed 响应
- [ ] 单条超时（复用 `LOAD_TIMEOUT_MS`）与失败跳过，不让一条卡死整批
- [ ] 条间加间隔（复用 `scrollIntervalMs` 量级），不一股脑打过去
- [ ] `aborted` 在详情阶段每条之间检查，暂停/取消 1 秒内生效
- [ ] 诊断：每条详情的结果写进拦截日志（成功/跳过/失败原因）
- [ ] 提交：`feat: resolve xiaohongshu note details before saving`

### 任务 4：打开 taskReady 与界面接入

**文件：** `src/main/adapters/xiaohongshu.ts`、渲染层、`tests/`

- [ ] `taskReady` 置 true，小红书进入建任务下拉框
- [ ] 作者输入提示、下载 Referer、作品链接白名单按实测校对
- [ ] 使用说明页补小红书条目（含「搜索里图文占多数、抓视频要多滚」的预期说明）
- [ ] 提交：`feat: enable xiaohongshu tasks`

### 任务 5：真机烟测与验收

- [ ] 关键词任务，目标数量 3，自动下载
- [ ] 确认：命中搜索接口 → 跳过图文 → 逐条详情 → 入库字段正确 → 下载成功
- [ ] **重点验证编码**：下载到的文件用 ffprobe 看实际编码，确认 EF4/EF5 对应什么、FFmpeg 能否正常转码
- [ ] 暂停/继续/取消各一次，确认详情阶段可打断
- [ ] 记录验收文档

### 任务 6（本轮不做，单独立项）：作者主页任务

- [ ] 作者主页接口未取证。接入前必须先真机抓一次，不得推测。

## 已知风险

1. **`EF4`/`EF5` 编码含义未知。** 是小红书自有标识，不确定对应 H.264 还是 H.265，也可能是自研编码。
   若 FFmpeg 解不了，标准化会失败——现有逻辑会保留源文件并记 `normalization_error`，不会丢文件，
   但输出规格无法保证。任务 5 必须实测确认。
2. **视频笔记在搜索结果中占少数。** 实测未筛选时 20 条里仅 1 条是视频。目标数量 20 可能要滚很多屏，
   甚至触发停滞自救。可能需要为小红书单独调高停滞阈值，或在界面上提示预期。
3. **每条视频一次页面导航。** 目标 200 条即 200 次加载，耗时与风控暴露都显著高于前两个平台。
   若真机验证下来过慢，应考虑限制小红书任务的目标数量上限，或提示用户分批。
4. **签名地址约 3.7 天到期。** 长时间暂停后恢复的任务，已存的 `play_addr` 可能已失效；
   现有下载器有地址过期回退，但小红书需要真机确认该路径可用。
5. **搜索筛选无法写进网址。** 只能在解析层丢弃图文，这会放大风险 2。
