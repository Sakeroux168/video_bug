import React from 'react'
import { Card } from './ui'

/**
 * Task2（round15）：程序内置「使用说明」页。纯静态展示，不需要 IPC/props。
 * 内容以 docs/员工使用说明.md 为准，但删掉「怎么拿到 exe」「SmartScreen 首次放行」两节
 * ——用户已经打开程序了，这两节在程序里没有意义。事实性内容（推荐值/风控提示/数据路径）
 * 与源文档保持一致，只是按界面重新分节排版。
 */

const situations: Array<{ scene: string; note: string; action: string }> = [
  {
    scene: '任务自动暂停，提示「已重搜 3 次仍爬不满」',
    note: '这个关键词的搜索结果就这么多，爬光了',
    action: '正常。换个关键词，或把目标数量调小'
  },
  {
    scene: '弹出验证码 / 机器人验证',
    note: '抖音风控',
    action: '程序会自动暂停。你在抖音窗口里手动完成验证，然后点「继续」'
  },
  {
    scene: '任务显示「已暂停」，错误是 stalled',
    note: '页面卡住不出新内容',
    action: '点「继续」重试；反复如此就换关键词'
  },
  {
    scene: '顶部「查看拦截日志」',
    note: '排查用的，能看到程序在干什么',
    action: '出问题时先看这里，截图给技术'
  }
]

const runParams: Array<{ label: string; value: string }> = [
  { label: '滚动间隔', value: '3500' },
  { label: '每页等待(秒)', value: '8' },
  { label: '停滞检测(秒)', value: '25' }
]

function SectionTitle({ index, children }: { index: string; children: React.ReactNode }): React.ReactElement {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-brand-50 text-xs font-medium text-brand-600">{index}</span>
      {children}
    </h3>
  )
}

export default function HelpPanel(): React.ReactElement {
  return (
    <div className="max-w-3xl space-y-4 pb-6 text-sm text-slate-600">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-slate-800">使用说明</h2>
        <p className="mt-1 text-xs text-slate-400">给同事看的操作指南，遇到问题先看这里</p>
      </div>

      <Card>
        <SectionTitle index="1">首次设置</SectionTitle>
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-slate-700">设下载目录</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              进「设置」页，把「下载目录」改成你自己的路径，比如 <code className="rounded bg-slate-100 px-1 py-0.5">D:\抖音视频</code>。
              <span className="text-amber-600">注意选一个空间大的盘</span>——视频很占地方，爬几百条就是几十 GB。
            </p>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-700">扫码登录抖音</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              点开「内置浏览器」窗口，会显示抖音页面。按正常方式扫码登录你自己的抖音账号。
              登录状态会记住，以后不用重复扫。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle index="2">怎么爬</SectionTitle>
        <ol className="list-inside list-decimal space-y-1 text-xs leading-5 text-slate-500">
          <li>填关键词（或作者、话题）</li>
          <li>填目标数量——建议先填 20 试一次，跑通了再加大</li>
          <li>点「开始」</li>
        </ol>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          爬取过程中程序会自己滚动页面加载更多，不用你手动操作。爬完会自动下载，并按
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">品类\作者\一分钟内|一分钟外\</code>
          归档到你设的下载目录里。
        </p>
      </Card>

      <Card>
        <SectionTitle index="3">会遇到的情况</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400">
                <th className="py-2 pr-3 font-medium">现象</th>
                <th className="py-2 pr-3 font-medium">说明</th>
                <th className="py-2 font-medium">怎么办</th>
              </tr>
            </thead>
            <tbody>
              {situations.map(row => (
                <tr key={row.scene} className="border-b border-slate-100 align-top last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-700">{row.scene}</td>
                  <td className="py-2 pr-3 text-slate-500">{row.note}</td>
                  <td className="py-2 text-slate-500">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle index="4">注意事项</SectionTitle>
        <div className="space-y-3 text-xs leading-5 text-slate-500">
          <p>
            <span className="font-medium text-red-500">别开多个程序窗口。</span>
            同一台机器只能跑一个，多开会互相抢数据库，导致数据错乱。
          </p>
          <div>
            <p><span className="font-medium text-red-500">别爬太猛。</span>
              目标数量一次填几千、或者好几个人同时用同一个账号大量爬，会明显提高抖音风控
              （验证码、限流甚至封号）的概率。建议：
            </p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>单次目标数量控制在几百以内</li>
              <li>每个人用自己的账号</li>
              <li>别把设置里的「滚动速度」调快——默认的「慢」就是为了降低风控</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-slate-700">设置里这三项别乱调（默认值是测出来的，调错会导致爬不动）：</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {runParams.map(p => (
                <span key={p.label} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
                  {p.label}：<span className="font-medium text-slate-700">{p.value}</span>
                </span>
              ))}
            </div>
            <p className="mt-2 text-slate-400">
              如果你把「停滞检测」调得太小，程序会自动兜到安全值并在日志里说明——但还是别调。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle index="5">数据存在哪</SectionTitle>
        <ul className="space-y-1 text-xs leading-5 text-slate-500">
          <li><span className="font-medium text-slate-700">视频文件：</span>你在设置里指定的下载目录</li>
          <li>
            <span className="font-medium text-slate-700">任务记录、登录状态：</span>
            <code className="rounded bg-slate-100 px-1 py-0.5">%APPDATA%\video-scraper</code>
            （在文件管理器地址栏粘贴这个路径就能打开）
          </li>
        </ul>
        <p className="mt-2 text-xs text-slate-400">
          换电脑的话，把 %APPDATA%\video-scraper 整个文件夹拷过去，任务记录和登录状态都能带走。
        </p>
      </Card>

      <Card>
        <SectionTitle index="6">暂时用不了的功能</SectionTitle>
        <p className="text-xs leading-5 text-slate-500">
          <span className="font-medium text-slate-700">AI 自动判断品类</span>
          （听语音 + 看画面识别作者属于哪个品类）目前没有开启，因为需要配置 API Key。
          现在的归档规则是：作者已有品类 → 沿用；没有 → 归到「未分类」。
          需要开启的话找技术在设置页填 Key。
        </p>
      </Card>
    </div>
  )
}
