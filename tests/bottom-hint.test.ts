import { describe, it, expect } from 'vitest'
import { isBottomHint } from '../src/main/bottomHint'

// 2026-10-06 全面检查 B3：「到底」识别以前扫整屏文字，卡片标题里带「到底」就当翻完了，只收第一屏就收工

describe('B3 只认平台的「到底」提示，不认标题里的字', () => {
  it('平台真正的到底提示 → 算', () => {
    for (const t of ['暂时没有更多了', '没有更多了', '没有更多内容了', '没有更多作品了', '- THE END -', 'THE END',
      '已经到底了', '到底了~', '— 到底啦 —', '暂时没有更多视频了', '没有更多的内容了']) {
      expect(isBottomHint(t), t).toBe(true)
    }
  })

  it('标题、正文里恰好有这几个字 → 不算', () => {
    for (const t of ['这家店到底值不值得去', '到底是谁在买', '暂时没有更好的办法了', '没有更多钱了怎么办',
      '他到底了吗', 'The end of summer', '猫咪到底有多爱你', '']) {
      expect(isBottomHint(t), t).toBe(false)
    }
  })
})
