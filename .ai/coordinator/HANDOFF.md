# video_bug 当前交接

> 当前执行快照，随进度重写；历史看 Git。更新于 2026-09-29（作者主页通过后）。

## 基线

- `master`：`05f509b`。进行中分支：`pr1`（Draft PR #3 `pr1 → master`）。代码最新 `595e997`（总控接手 Codex 未提交的工作并补修）。

## 已确认

- 小红书关键词真机 PASS：「搞笑」5 条、「化妆」4 条。**作者主页真机 PASS**：两个作者各 3/3。ffprobe 全部正常，库里链接不带 token（PR #3 评论）。
- 抖音关键词在已登录的测试档案下正常。自动化：vitest 947 项通过，typecheck 通过（`595e997`）。

## 未完成

1. **三种抓取模式还没开工**（决定见 MEMORY）。总控做的技术摸底：
   - 每条约 15 秒的原因：Electron `webContents.executeJavaScript` 会「等页面停止加载后才执行」（官方文档原文）。改用 `webContents.mainFrame.executeJavaScript` 就不用等，这是稳妥模式提速的方向。
   - 快速模式可行：已登录状态下取详情页 HTML 约 0.9 秒，`window.__INITIAL_STATE__` 里有 `noteDetailMap[id].note`（含 EF4/EF5 视频流，`currentNoteId` 是纯字符串）。这段状态不是标准 JSON，含 `undefined`、`new Map([])`，需要先宽松清理再解析。
   - **接口模式：总控的探测被 Claude Code 安全审核拦下，未验证。是否做、谁来做，由用户决定。**
   - 总控继续实现时，读源码被审核以「Auto-Mode Bypass」为由拦下。用户决定：**稳妥提速 + 快速模式交给 DeepSeek V4.1 Flash**，任务单是 `E:\项目文件\视频爬取\claude工作区\派活\2026-09-29-小红书稳妥提速与快速模式.md`。它做完后由总控复核。接口模式不在这张单里。
2. **Codex 本地工作区**：`codex工作区\video_bug` 里还留着和 `595e997` 内容相同的未提交改动，另有 `.tmp-cdp.mjs`、`.tmp-probe.mjs`。Codex 下次开工前要先确认 `origin/pr1` 已包含这些改动，丢掉本地改动（`git checkout -- src tests`），再 `git pull`。
3. 测试档案实例（带 `--remote-debugging-port=9333`，只监听本机）是总控为诊断开的，不需要时可以关掉。
4. 非阻断跟进：作者 + 自定义日期的日志误报；`taskCreate` 提示文案写死；`package-lock.json` 不同步。

## 下一步

- DeepSeek V4.1 Flash 按任务单实现 → 总控复核 → 用户真机验收。接口模式要等用户自己决定（需要用户在设置里放行）。
