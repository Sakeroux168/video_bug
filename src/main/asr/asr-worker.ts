// src/main/asr/asr-worker.ts — 转写子进程
// 与 ainame worker.js 对齐。
//
// 独立脚本，由主进程用 spawn 拉起（走 ffmpeg 一样的 run() 套路），
// 输入用请求 JSON 文件、结果用一行 stdout JSON 传回。
//
// 为什么非得是子进程（两个理由，各自都足够）：
//
//   1. recognizer.decode() 是【同步】调用。放在主进程里，一条几分钟的
//      视频能把事件循环卡住好几秒 —— 界面整个僵住，进度条也不动。
//   2. sherpa-onnx-node 是原生插件，在 Electron 里有已知的加载路径问题
//      （上游 issue #1945）。子进程里是干净的 Node 环境，绕开这一整类麻烦。
//
// 调用方式：
//   node out/main/asr-worker.js <请求JSON文件路径>
// 结果以一行 JSON 打到 stdout。用文件传参数而不是命令行，是因为路径里
// 可能有中文和空格，绕开所有引号转义问题。

import fs from 'node:fs'

// 一次性喂给模型的最长音频。
//
// SenseVoice 是在 30 秒以内的语句上训练的。实测 34 秒整段喂进去效果
// 反而比切段【更好】（"面黄肌瘦""拱不动""媳妇呀"整段都对，切段后
// 变成了"面黄肌受""供不动""媳不呀"），因为切段会在句子中间截断上下文。
// 所以策略是：短音频整段喂，只有超过这个长度才用 VAD 切。
const WHOLE_FILE_LIMIT_SEC = 30

// ============================================================
// ★ 在 Electron 下必须关掉 external buffer
// ============================================================
// sherpa-onnx-node 里所有返回音频样本的接口都默认 enableExternalBuffer=true，
// 也就是让 JS 的 Float32Array 直接指向 C++ 那边的内存，省一次拷贝。
//
// 但 Electron 的 V8 【禁止】创建 external ArrayBuffer，一调用就抛：
//     Error: External buffers are not allowed
//
// 普通 Node 允许，Electron 不允许 —— 所以"在命令行下用 node 跑通了"
// 完全不能说明它在程序里能跑。上一轮就是这么踩的：node v22 下验证通过，
// 实际 worker 跑在 Electron 的 Node v24 下，第一句 readWave 就炸。
//
// 关掉之后是多一次内存拷贝。一条 10 分钟的音频 16kHz 单声道约 19MB，
// 拷一次的代价可以忽略，和识别本身差好几个数量级。
const EXTERNAL_BUFFER = false

// 报错退出。
//
// 【不要用 process.exit】。stdout/stderr 接到管道时是异步写的，
// process.exit 会在缓冲冲刷完之前就把进程干掉，于是父进程一个字也收不到 ——
// 表现成"worker 静默失败"或者"只看到 Node 自己打的裸栈"。
// 设 exitCode 然后让 main 自然返回，Node 会在退出前把管道写完。
class WorkerError extends Error {}

function fail(msg: string): never {
  throw new WorkerError(String(msg))
}

// sherpa-onnx-node 不带 .d.ts 类型声明（原生 N-API 插件），下面所有
// native 对象一律用 any 收敛，避免和原生类型互相咬合。
// @ts-ignore 加载失败要给可读提示，不能裸抛
function loadSherpa(): any {
  try {
    // @ts-ignore 该 npm 包不携带类型声明，用 any
    return require('sherpa-onnx-node')
  } catch (e) {
    fail(
      '加载 sherpa-onnx-node 失败：' + (e as Error).message +
      '\n请在项目目录下执行 npm install 重新安装依赖。'
    )
  }
}

// VAD 切段。
//
// 注意 silero-VAD 【不能】用来判断"这段音频里有没有人说话" ——
// 实测它对纯背景音乐和唱歌一样会判成语音（两条纯 BGM 的素材分别被判成
// 96% 和 73% 是语音）。它在这里只干两件事：
//   1. 长音频切成模型吃得下的段
//   2. 算出"语音总时长"，给主进程判断转写结果可不可信用
//      （按语音时长算字数密度，而不是按视频总长 —— 一条 60 秒的视频
//       只在最后 3 秒有人说话时，按总长算会误判成"没人说话"）
function runVad(sherpa: any, samples: Float32Array, vadModel: string): any[] {
  const vad = new sherpa.Vad({
    sileroVad: {
      model: vadModel,
      threshold: 0.5,
      minSilenceDuration: 0.35,
      minSpeechDuration: 0.25,
      maxSpeechDuration: WHOLE_FILE_LIMIT_SEC,
      windowSize: 512
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  }, 120)

  const segments: any[] = []
  const window = 512

  for (let i = 0; i + window <= samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, i + window))
    // front() 同样默认走 external buffer，在 Electron 下会抛。见文件头 EXTERNAL_BUFFER
    while (!vad.isEmpty()) { segments.push(vad.front(EXTERNAL_BUFFER)); vad.pop() }
  }

  vad.flush()
  while (!vad.isEmpty()) { segments.push(vad.front(EXTERNAL_BUFFER)); vad.pop() }

  return segments
}

function decodeOne(recognizer: any, samples: Float32Array): any {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  recognizer.decode(stream)
  return recognizer.getResult(stream)
}

function makeRecognizer(sherpa: any, req: any, provider: string): any {
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: req.model,
        // ITN 打开才有标点。这一条不能省 ——
        // 没有标点的整段文本喂给文本模型，它分不清句子边界，
        // 起出来的标题会把两句话的意思揉成一句。
        useInverseTextNormalization: 1
      },
      tokens: req.tokens,
      numThreads: req.numThreads || 4,
      provider,
      debug: 0
    }
  })
}

function main(): void {
  const reqFile = process.argv[2]
  if (!reqFile) fail('用法: node asr-worker.js <请求JSON文件路径>')

  let req: any
  try {
    // 去掉 BOM。我们自己写的文件不带（Node 的 writeFile 不加），
    // 但手工造请求文件调试时（PowerShell 的 -Encoding utf8 就会加）
    // 一个不可见字符会让 JSON.parse 报一句莫名其妙的错。
    const raw = fs.readFileSync(reqFile, 'utf8').replace(/^﻿/, '')
    req = JSON.parse(raw)
  } catch (e) {
    fail('读取请求文件失败: ' + (e as Error).message)
  }

  for (const k of ['wav', 'model', 'tokens', 'vad']) {
    if (!req[k]) fail(`请求里缺少 ${k}`)
    if (!fs.existsSync(req[k])) fail(`文件不存在: ${req[k]}`)
  }

  const sherpa = loadSherpa()
  const t0 = Date.now()

  // 显卡档。
  //
  // 实测：npm 装的 sherpa-onnx-node 带的是 CPU 版 onnxruntime，选 cuda
  // 【不会抛错】。sherpa 自己静默切回 CPU，只在 stderr 上留一句
  //   "Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!"
  // 所以这里的 try/catch 只是兜底（万一哪天换的包真会抛），
  // 真正判断有没有用上显卡是主进程在读 stderr。
  //
  // 而且 CPU 本来就够快：i9-9900K 四线程 29 倍速，
  // 一条 10 分钟的视频 20 秒转完，显卡在这里省不下什么。
  let recognizer: any
  const requested = req.provider === 'cuda' ? 'cuda' : 'cpu'
  let provider = requested
  let providerFellBack = false

  try {
    recognizer = makeRecognizer(sherpa, req, provider)
  } catch (e) {
    if (provider === 'cpu') fail('加载识别模型失败: ' + (e as Error).message)
    provider = 'cpu'
    providerFellBack = true
    recognizer = makeRecognizer(sherpa, req, provider)
  }

  const loadMs = Date.now() - t0

  // 第二个参数是 enableExternalBuffer，在 Electron 下必须传 false，
  // 否则这一句就是 "External buffers are not allowed"。见文件头。
  const wave = sherpa.readWave(req.wav, EXTERNAL_BUFFER)
  const totalSec = wave.samples.length / 16000

  const t1 = Date.now()

  // VAD 一定要跑 —— 即使音频很短不需要切段，也要靠它算语音时长
  const segments = runVad(sherpa, wave.samples, req.vad)
  const speechSec = segments.reduce((a: number, s: any) => a + s.samples.length / 16000, 0)

  let text: string
  let event = ''
  let emotion = ''
  let lang = ''

  if (totalSec <= WHOLE_FILE_LIMIT_SEC) {
    const r = decodeOne(recognizer, wave.samples)
    text = (r.text || '').trim()
    event = r.event || ''
    emotion = r.emotion || ''
    lang = r.lang || ''
  } else {
    const parts: string[] = []
    for (const seg of segments) {
      const r = decodeOne(recognizer, seg.samples)
      const t = (r.text || '').trim()
      if (t) parts.push(t)
      // 第一段的标签当作整条的标签，够用了
      if (!event) { event = r.event || ''; emotion = r.emotion || ''; lang = r.lang || '' }
    }
    text = parts.join(' ')
  }

  const decodeMs = Date.now() - t1

  process.stdout.write(JSON.stringify({
    text,
    event, emotion, lang,
    totalSec: Math.round(totalSec * 100) / 100,
    speechSec: Math.round(speechSec * 100) / 100,
    segments: segments.length,
    whole: totalSec <= WHOLE_FILE_LIMIT_SEC,
    requestedProvider: requested,
    provider,
    providerFellBack,
    loadMs,
    decodeMs
  }) + '\n')
}

// 整体包起来。
//
// 早先 main() 是裸调用的：readWave / Vad / decode 任何一步抛错都会变成
// Node 打印的未捕获异常裸栈，而父进程那边又只截尾部，于是用户看到的是
// 一堆 `at Module._load` —— 完全看不出发生了什么。
//
// 现在无论哪一步炸，stderr 的【第一行】都是一句能读的话，
// 后面才跟原始错误和栈。主进程挑第一行就是人话。
try {
  main()
} catch (e: any) {
  const isOurs = e instanceof WorkerError

  process.stderr.write(
    (isOurs ? e.message : `语音转写子进程出错：${e && e.message || e}`) + '\n'
  )

  // 原始信息另起一段，方便复制给开发者，但不影响第一行的可读性
  if (!isOurs && e && e.stack) {
    process.stderr.write('\n原始错误：\n' + e.stack + '\n')
  }

  process.exitCode = 1
}
