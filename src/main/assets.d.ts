// electron-vite：import x from './a.png?asset' 得到打包后文件的绝对路径（托盘图标用）
declare module '*?asset' {
  const path: string
  export default path
}
