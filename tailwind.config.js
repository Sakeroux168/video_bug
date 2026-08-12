/** @type {import('tailwindcss').Config} */
const colors = require('tailwindcss/colors')

module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 主色 teal（teal-600 === #0D9488）。整条 ramp 直接白拿，不手写色阶。
        // 约束：brand 只用于「可点的主操作」——主按钮 / 激活 tab / 焦点环 / 选中底色 / 框选遮罩。
        // 状态色不许用 brand：teal-600 与 emerald-600 色相只差约 12°，红绿色觉异常者
        // （男性约 8%）无法区分「主按钮」与「完成状态」。下载中状态另用 sky。
        brand: colors.teal,
        success: colors.emerald,
        warning: colors.amber,
        danger: colors.red
      },
      fontFamily: {
        // 不引任何外部字体：本程序打包后离线运行，Google Fonts 拿不到，
        // 且界面以中文为主，拉丁字体不覆盖中文只会静默 fallback。
        //
        // 刻意不写 system-ui：中文 Windows 上它直接解析成「微软雅黑 UI」，
        // 会吃掉后面 Segoe UI 的机会，而雅黑的西文与数字字形明显更差。
        // Segoe UI 打头 → 拉丁字母和数字走 Segoe，中文自动回落雅黑，这正是数据界面要的。
        sans: ['"Segoe UI"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', '"PingFang SC"', 'sans-serif']
      }
    }
  },
  plugins: []
}
