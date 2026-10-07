import React from 'react'
import { Card } from './ui'

/**
 * Task2（round15）：程序内置「使用说明」页。纯静态展示，不需要 IPC/props。
 * 内容以 docs/使用说明.md 为准，但删掉「怎么拿到 exe」「SmartScreen 首次放行」两节
 * ——用户已经打开程序了，这两节在程序里没有意义。事实性内容（推荐值/风控提示/数据路径）
 * 与源文档保持一致，只是按界面重新分节排版。
 */

const situations: Array<{ scene: string; note: string; action: string }> = [
  {
    scene: '任务自动暂停，提示「已重搜 3 次仍爬不满」',
    note: '可能没有更多结果，也可能是没登录 / 有验证',
    action: '先看任务行的暂停原因和平台登录状态，打开平台窗口确认；登录或完成验证后点「继续」，再考虑换关键词或调小数量'
  },
  {
    scene: '弹出验证码 / 机器人验证',
    note: '当前平台要求验证',
    action: '程序会自动暂停。你在对应平台窗口里手动完成验证，然后点「继续」'
  },
  {
    scene: '任务行提示「没登录」',
    note: '当前平台要求先登录',
    action: '点任务行的「打开平台窗口」，登录后回到任务页点「继续」；各平台登录状态独立'
  },
  {
    scene: '任务状态是「没有新结果」',
    note: '页面卡住不出新内容',
    action: '先在平台窗口确认是否没登录 / 有验证，处理后点「继续」；没有这些提示再换关键词'
  },
  {
    scene: '顶部「查看拦截日志」',
    note: '排查问题用的，能看到程序在干什么',
    action: '平时不用管；遇到解决不了的问题，可以把里面的内容截图，连同问题描述一起反馈'
  }
]

const runParams: Array<{ label: string; value: string }> = [
  { label: '滚动间隔', value: '3500' },
  { label: '每页最大等待(秒)', value: '8' },
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
        <p className="mt-1 text-xs text-slate-400">操作指南，遇到问题先看这里</p>
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
            <div className="text-xs font-medium text-slate-700">扫码登录平台账号</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              在「内置浏览器」打开要使用的平台窗口，按正常方式扫码登录你自己的账号。
              以平台登录状态灯显示「已登录」为准；「未知」时在平台窗口确认。看到首页不代表已经登录。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle index="2">怎么爬</SectionTitle>
        <ol className="list-inside list-decimal space-y-1 text-xs leading-5 text-slate-500">
          <li>填关键词（或作者、话题）</li>
          <li>填目标数量——建议先填 20 试一次，跑通了再加大</li>
          <li>点「开始抓取」（或者在输入框里直接按回车）</li>
        </ol>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          爬取过程中程序会自己滚动页面加载更多，不用你手动操作。爬完会自动下载到你设的下载目录里。
        </p>
        <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          默认视频就直接放在下载目录，不分文件夹。想分类的话去「设置 → 下载后分文件夹整理」，
          可以单独勾选
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">品类 / 作者 / 横竖屏 / 时长</code>
          四层里的任意几层，勾了几层就建几层目录。改这里只影响之后下载的视频，已经归好的文件不会自动搬家。
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
            <span className="font-medium text-danger-600">别开多个程序窗口。</span>
            同一台机器只能跑一个，多开会互相抢数据库，导致数据错乱。
          </p>
          <div>
            <p><span className="font-medium text-danger-600">别爬太猛。</span>
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
          （听语音 + 看画面识别作者属于哪个品类）默认没有开启，因为需要 API Key。
          勾了「按品类分文件夹」时的规则是：作者已有品类 → 沿用；没有 → 放进「未分类」。
          一项都不勾的话，视频直接放在下载目录里，不分文件夹。
          想开启 AI 判断，在「设置 → AI 配置」里填好 API Key 就行。
        </p>
      </Card>

      <Card>
        <SectionTitle index="7">和百家号发布助手一起用</SectionTitle>
        <div className="space-y-2 text-xs leading-5 text-slate-500">
          <p>
            本程序负责把作者的视频下下来，发布助手负责处理和发到百家号。发布助手在「设置 → 发布」里填本程序的下载目录后，
            会自动把「品类\作者\」里新下的视频按作者名拉进各达人的暂存；作者文件夹名要和发布助手达人表里的达人名或站外昵称一样。
          </p>
          <p>
            「设置 → 和百家号发布助手打通」里的本机接口开着时，发布助手（或它的助手）可以直接让本程序去抓某几个作者的主页。
            下载的都是平台上的原视频，不会重新编码；需要统一分辨率时，去「视频处理」页对整个文件夹处理一遍。
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle index="8">免费版本与许可</SectionTitle>
        <div className="space-y-2 text-xs leading-5 text-slate-500">
          <p>
            这是项目维护者提供的<span className="font-medium text-emerald-600">官方免费版本</span>。
            项目采用 MIT + Commons Clause 的<span className="font-medium text-slate-700">源码可用</span>许可：
            允许利用软件输出赚钱，但禁止出售软件本身、换皮版或把软件本体做成主要收费服务。
          </p>
          <p>
            源码地址：
            <code className="ml-1 break-all rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              https://github.com/Sakeroux168/video_bug
            </code>
          </p>
          <p>
            软件按现状提供、不作担保。FFmpeg、Electron、React 等第三方组件遵守各自许可证；
            完整文本随程序放在 <code className="rounded bg-slate-100 px-1 py-0.5">resources\licenses</code>。
          </p>
        </div>
      </Card>
    </div>
  )
}
