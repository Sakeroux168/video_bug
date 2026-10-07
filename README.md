# video-scraper 视频爬取工具

批量抓取 **抖音、快手、小红书** 视频信息并下载原视频的 Windows 桌面工具（Electron + React + TypeScript）。

- 按 **关键词 / 作者主页 / 话题** 抓取，作者主页支持按日期段抓和「只抓新视频」（追更）
- 在内置浏览器里用你自己的账号登录，程序像真人一样滚动页面，从页面自己加载的数据里读取视频信息
- 自动下载原视频（不重新编码），支持分段下载、暂停 / 继续、失败重试，显示进度和速度
- 作者收藏：批量导入作者名单、核对名字和链接是否一致、追更、导出表格
- 下载后可按关键词 / 品类 / 作者 / 横竖屏 / 时长分文件夹整理；「视频处理」页可统一分辨率
- 自动化：关窗口缩到托盘后台跑、抓完 / 要登录时弹系统通知、每天定时给作者追更
- 素材库：用封面挑视频，打星标 / 待用 / 已用、写备注；勾几条一键「打包交付」（复制 + 来源清单）
- 删除的文件进回收站，删掉的视频不会被追更重新下回来，后悔了可以恢复

详细用法见 **[docs/使用说明.md](docs/使用说明.md)**（软件左侧「使用说明」页内容相同）。

## 免责声明

- 本项目**仅供个人学习和研究**使用。
- 使用本工具时，请遵守各平台的用户协议和 robots 规则，以及你所在地的法律法规；**不要**用于大规模采集、绕过平台安全措施、侵犯他人隐私或任何违法用途。
- 下载的视频、图片、文字等内容的版权归原作者和平台所有。只处理你有权处理的内容；转载、二次创作前请取得授权。
- 程序只读取你登录后浏览器页面本来就会加载的数据，不破解、不伪造平台接口签名，也不收集、上传任何账号信息。
- 因使用本工具产生的一切后果（包括账号被限制、内容侵权等）由使用者自行承担，作者不承担任何责任。本软件按「原样」提供，不提供任何担保。

## 许可

**源码可用（Source Available）**，不是 OSI 定义的开源：采用 [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。

- **非商业用途免费**：个人学习、研究、兴趣项目，学校、公益机构使用，都可以免费用、改、分享（保留许可和署名）。
- **商业用途要买商业授权**：公司或个人在业务里使用（包括只在内部用）、接单、出售、换皮、做成收费服务，都要先向作者购买授权。
  联系方式：在本仓库开一个 Issue，标题写「商业授权」。
- 第三方组件（FFmpeg、Electron、React、sherpa-onnx 等）按各自许可证使用。
- 2026-10-07 之前发布的版本用的是 MIT + Commons Clause。

详见 [LICENSE](LICENSE)、[中文说明](LICENSE.zh-CN.md)、[NOTICE](NOTICE)、[TRADEMARKS.md](TRADEMARKS.md)。

## 开发

需要 Windows、Node.js 24（`node:sqlite`）。

```bash
npm ci            # 安装依赖
npm run dev       # 开发模式启动
npm run verify    # 类型检查 + 全部测试 + 构建 + CSS / 许可检查（CI 跑的就是这个）
```

### 打包

打包会把 ffmpeg 一起带上。先准备 Windows 版 ffmpeg（例如 gyan.dev 的 essentials build），任选一种：

- 把 `ffmpeg.exe`、`ffprobe.exe` 放进 `vendor/ffmpeg/bin/`（这个文件夹不进 git）；或者
- 设置环境变量 `FFMPEG_BIN_DIR` 指向含这两个 exe 的 `bin` 目录，打包时会自动复制。

```bash
npm run dist      # 产物：dist/video-scraper-<版本>-portable.exe
```

### 目录

| 路径 | 内容 |
|---|---|
| `src/main/` | 主进程：调度器（滚动 / 停滞自救 / 看门狗）、下载器、数据库、各平台适配器（`adapters/`）、本机接口 |
| `src/renderer/` | 界面（React + Tailwind） |
| `src/preload/` | 主进程和界面之间的接口 |
| `tests/` | vitest 测试（`tests/components/` 是界面测试，跑在 jsdom 里） |
| `scripts/` | 构建检查脚本（CSS 产物、第三方许可、打包前准备 ffmpeg） |

## 数据存在哪

- 视频：设置里的下载目录
- 任务记录、登录状态：`%APPDATA%\video-scraper`
