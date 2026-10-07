// jsdom 没装类型声明包；测试里只用到 new JSDOM(html).window.document，按 any 处理即可
declare module 'jsdom'
