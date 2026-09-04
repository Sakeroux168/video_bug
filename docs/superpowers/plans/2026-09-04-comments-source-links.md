# Comments and Source Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display Douyin comment counts and canonical work-page links, with safe open/copy actions that preserve the existing video-table selection behavior.

**Architecture:** Extend the existing `VideoItem` and additive SQLite migration so comments and source links travel through the current adapter and scheduler paths. Keep platform URL construction and host allowlists on `PlatformAdapter`; the main process resolves legacy rows and opens only validated HTTPS work pages. Reuse the existing main-process clipboard IPC and native row controls in `TaskList`.

**Tech Stack:** Electron 35, React 18, TypeScript 5.6, `node:sqlite`, Vitest, Testing Library.

## Global Constraints

- `comments` is `number | null`: real zero remains `0`; missing, negative, fractional, non-numeric, or non-finite values become `null`.
- `sourceUrl` is a platform work-page URL, never a CDN media URL.
- Old databases gain `source_url TEXT` additively; old rows remain readable and receive a canonical fallback from `platform + aweme_id` at the IPC boundary.
- Only `https://` URLs whose exact hostname belongs to the row's platform adapter may be opened externally.
- Copy/open controls must remain native `button` elements and must not change click, Ctrl/Shift, checkbox, or marquee selection.
- Reuse `clipboard:write`, `PlatformAdapter`, `listVideos`, and the existing task table; do not add a URL, clipboard, state-management, or migration dependency.
- Do not log cookies, signatures, response bodies, or CDN URLs while adding diagnostics.
- This plan implements phase 1 only. FFmpeg normalization, licensing, Kuaishou, and Xiaohongshu remain separate independently testable plans.

---

### Task 1: Extend the normalized adapter contract

**Files:**
- Modify: `src/main/adapters/types.ts`
- Modify: `src/main/adapters/douyin.ts`
- Test: `tests/douyin-adapter.test.ts`

**Interfaces:**
- Consumes: Douyin `statistics.comment_count` and `aweme_id`.
- Produces: `VideoItem.comments: number | null`, `VideoItem.sourceUrl: string`, `PlatformAdapter.sourceHosts: readonly string[]`, and `PlatformAdapter.buildVideoUrl(workId: string): string`.

- [ ] **Step 1: Write failing adapter tests**

Add `comment_count: 0` to the shared `AWEME.statistics` fixture and extend the expected normalized item:

```ts
comments: 0,
sourceUrl: 'https://www.douyin.com/video/7300000000000000001'
```

Add explicit unknown and nonzero cases:

```ts
it('评论数保留真实0与非零值，缺失或非法值归一为null', () => {
  const parse = (comment_count: unknown, include = true) => {
    const statistics = include ? { digg_count: 1, comment_count } : { digg_count: 1 }
    return douyinAdapter.parseApiJson('https://x/', {
      aweme_list: [{ ...AWEME, statistics }]
    })[0].comments
  }
  expect(parse(0)).toBe(0)
  expect(parse(45)).toBe(45)
  expect(parse('45')).toBe(45)
  expect(parse(undefined, false)).toBeNull()
  expect(parse(-1)).toBeNull()
  expect(parse(1.5)).toBeNull()
  expect(parse('bad')).toBeNull()
})

it('作品链接和允许主机由适配器声明', () => {
  expect(douyinAdapter.buildVideoUrl('7300000000000000001'))
    .toBe('https://www.douyin.com/video/7300000000000000001')
  expect(douyinAdapter.sourceHosts).toEqual(['www.douyin.com'])
})
```

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `npx vitest run tests/douyin-adapter.test.ts`

Expected: type/assertion failures because the new fields and adapter members do not exist.

- [ ] **Step 3: Implement the minimal normalized contract**

Add to `VideoItem`:

```ts
comments: number | null
sourceUrl: string
```

Add to `PlatformAdapter`:

```ts
sourceHosts: readonly string[]
buildVideoUrl(workId: string): string
```

Use a strict parser in `douyin.ts`:

```ts
function nonNegativeIntegerOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}
```

Return the two new fields from `parseAweme`, and declare the adapter members:

```ts
comments: nonNegativeIntegerOrNull(stats.comment_count),
sourceUrl: `https://www.douyin.com/video/${id}`

sourceHosts: ['www.douyin.com'],
buildVideoUrl: (workId: string) => `https://www.douyin.com/video/${encodeURIComponent(workId)}`,
```

- [ ] **Step 4: Run the adapter tests and verify GREEN**

Run: `npx vitest run tests/douyin-adapter.test.ts`

Expected: all Douyin adapter tests pass.

- [ ] **Step 5: Commit the normalized contract**

```bash
git add src/main/adapters/types.ts src/main/adapters/douyin.ts tests/douyin-adapter.test.ts
git commit -m "feat: capture comments and source links"
```

---

### Task 2: Persist comments and source URLs through every insertion path

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/db.ts`
- Modify: `src/main/scheduler.ts`
- Test: `tests/db.test.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `VideoItem.comments` and `VideoItem.sourceUrl` from Task 1.
- Produces: `VideoRow.source_url: string | null`; SQLite `videos.source_url`; `stats` JSON shaped as `{ likes: number, comments: number | null }` for new rows.

- [ ] **Step 1: Write failing database persistence and migration tests**

Extend the `item()` fixture with `comments: 45` and `sourceUrl`. Then assert:

```ts
it('insertVideos 保存评论数和作品页链接，真实0不丢失', () => {
  const id = createTask(db, input)
  insertVideos(db, [item({ comments: 0 })], id, 'douyin')
  const [video] = listVideos(db, id)
  expect(video.source_url).toBe('https://www.douyin.com/video/AW1')
  expect(JSON.parse(video.stats)).toEqual({ likes: 10, comments: 0 })
})
```

Extend the old-database migration assertion:

```ts
expect(columns.map(c => c.name)).toContain('source_url')
expect(old.prepare('SELECT source_url FROM videos WHERE aweme_id=?').get('OLD1'))
  .toEqual({ source_url: null })
```

- [ ] **Step 2: Add a failing scheduler-path test**

In the existing controlled `handleRaw` test, include `comments` and `sourceUrl` on the adapter item, then assert both normal and AI-filtered insertions retain them:

```ts
const row = db.prepare('SELECT source_url, stats FROM videos WHERE aweme_id=?').get(item.awemeId) as {
  source_url: string | null
  stats: string
}
expect(row.source_url).toBe(item.sourceUrl)
expect(JSON.parse(row.stats)).toEqual({ likes: item.likes, comments: item.comments })
```

- [ ] **Step 3: Run focused persistence tests and verify RED**

Run: `npx vitest run tests/db.test.ts tests/scheduler.test.ts`

Expected: failures because `source_url` and comments are not written.

- [ ] **Step 4: Add the column and update the shared row type**

Add to the `videos` schema and `initDb` migration:

```sql
source_url TEXT,
```

```ts
addColumnIfMissing(db, 'videos', 'source_url', 'TEXT')
```

Add to `VideoRow`:

```ts
source_url: string | null
```

- [ ] **Step 5: Update all three insertion paths**

Update `insertVideos`, the scheduler's AI-filtered insert, and the scheduler's accepted insert so each writes `source_url` and serializes comments:

```ts
JSON.stringify({ likes: item.likes, comments: item.comments })
```

For filtered rows, write the same `stats` and `source_url` even though the row remains non-selectable.

- [ ] **Step 6: Run persistence tests and verify GREEN**

Run: `npx vitest run tests/db.test.ts tests/scheduler.test.ts`

Expected: database and scheduler suites pass.

- [ ] **Step 7: Commit the persistence flow**

```bash
git add src/shared/types.ts src/main/db.ts src/main/scheduler.ts tests/db.test.ts tests/scheduler.test.ts
git commit -m "feat: persist video comments and source urls"
```

---

### Task 3: Resolve legacy links and open only allowed work pages

**Files:**
- Create: `src/main/videoSource.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `tests/helpers/fake-api.ts`
- Create: `tests/video-source.test.ts`
- Create: `tests/ipc-video-source.test.ts`

**Interfaces:**
- Consumes: database `VideoRow.platform`, `aweme_id`, and nullable `source_url`; adapter `sourceHosts` and `buildVideoUrl`.
- Produces: `resolveVideoSourceUrl(platform, workId, storedUrl): string | null`; hydrated `task:video:list` rows whose legacy-null `source_url` contains the validated canonical fallback; preload `openVideoSource(id): Promise<{ ok: boolean; url?: string; error?: string }>`; IPC channel `video:source:open`.

- [ ] **Step 1: Write failing URL-policy tests**

```ts
expect(resolveVideoSourceUrl('douyin', 'AW1', null))
  .toBe('https://www.douyin.com/video/AW1')
expect(resolveVideoSourceUrl('douyin', 'AW1', 'https://www.douyin.com/video/AW1?from=test'))
  .toBe('https://www.douyin.com/video/AW1?from=test')
expect(resolveVideoSourceUrl('douyin', 'AW1', 'javascript:alert(1)')).toBeNull()
expect(resolveVideoSourceUrl('douyin', 'AW1', 'http://www.douyin.com/video/AW1')).toBeNull()
expect(resolveVideoSourceUrl('douyin', 'AW1', 'https://evil.example/video/AW1')).toBeNull()
expect(resolveVideoSourceUrl('unknown', 'AW1', 'https://www.douyin.com/video/AW1')).toBeNull()
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `npx vitest run tests/video-source.test.ts`

Expected: module/function not found.

- [ ] **Step 3: Implement strict source resolution**

```ts
export function resolveVideoSourceUrl(platform: string, workId: string, storedUrl: string | null): string | null {
  const adapter = getAdapter(platform)
  if (!adapter) return null
  const candidate = storedUrl === null || storedUrl.trim() === ''
    ? adapter.buildVideoUrl(workId)
    : storedUrl
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || !adapter.sourceHosts.includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Write a failing IPC test**

Register IPC with a memory database containing one row, mock `shell.openExternal`, then assert:

```ts
await expect(openVideoSource(video.id)).resolves.toMatchObject({ ok: true })
expect(shell.openExternal).toHaveBeenCalledWith('https://www.douyin.com/video/AW1')

db.prepare('UPDATE videos SET source_url=? WHERE id=?')
  .run('https://evil.example/video/AW1', video.id)
await expect(openVideoSource(video.id)).resolves.toEqual({ ok: false, error: '作品链接不安全或不受支持' })
expect(shell.openExternal).toHaveBeenCalledTimes(1)
```

Also assert a missing row returns `{ ok: false, error: '视频记录不存在' }`.

- [ ] **Step 5: Hydrate list results and expose the safe main-process action**

Change `task:video:list` to map every row through `resolveVideoSourceUrl`, replacing `source_url` with the validated stored URL or canonical legacy fallback. Add `video:source:open` to `registerIpc`. It accepts only a numeric database id, queries the row itself, resolves the URL, and calls `shell.openExternal` only after validation. Catch rejected opens and return `{ ok: false, error: '无法打开原视频' }`.

Expose it in preload and fake API:

```ts
openVideoSource: (id: number): Promise<{ ok: boolean; url?: string; error?: string }> =>
  ipcRenderer.invoke('video:source:open', id),
```

- [ ] **Step 6: Run URL and IPC tests and verify GREEN**

Run: `npx vitest run tests/video-source.test.ts tests/ipc-video-source.test.ts`

Expected: all policy and IPC tests pass; malicious values never reach `openExternal`.

- [ ] **Step 7: Commit the safe-open boundary**

```bash
git add src/main/videoSource.ts src/main/ipc.ts src/preload/index.ts tests/helpers/fake-api.ts tests/video-source.test.ts tests/ipc-video-source.test.ts
git commit -m "feat: open source videos through safe ipc"
```

---

### Task 4: Show and sort comments, and add row copy/open controls

**Files:**
- Modify: `src/renderer/src/components/TaskList.tsx`
- Modify: `tests/components/dom-contract.test.tsx`
- Modify: `tests/components/selection.test.tsx`
- Modify: `tests/components/tasklist-batch-matrix.test.tsx`
- Modify: `tests/components/batch-pause-resume.test.tsx`
- Modify: `tests/components/failure-display.test.tsx`
- Modify: `tests/components/video-delete.test.tsx`
- Create: `tests/components/tasklist-source-actions.test.tsx`

**Interfaces:**
- Consumes: `VideoRow.stats`, `source_url`, `author_nickname`; preload `writeClipboard` and `openVideoSource`.
- Produces: a sortable 评论 column, title subline with the source domain/truncated URL, and native buttons `打开原视频`, `复制链接`, `复制作者名`.

- [ ] **Step 1: Update component fixtures for the additive row field**

Add `source_url: 'https://www.douyin.com/video/AW1'` or `source_url: null` to every explicit `VideoRow` fixture in the listed component tests so TypeScript continues to enforce the real row shape.

- [ ] **Step 2: Write failing display and sorting tests**

Create rows with `stats` values `{}`, malformed JSON, `comments: 0`, and `comments: 25`. Assert the column displays `—`, `—`, `0`, and `25`. Click 评论 twice and assert ascending then descending known-value order, with unknown rows remaining after known rows in both directions.

```tsx
fireEvent.click(screen.getByRole('button', { name: '评论' }))
expect(visibleVideoTitles()).toEqual(['零评论', '二十五评论', '未知评论', '损坏统计'])
fireEvent.click(screen.getByRole('button', { name: '评论 ↑' }))
expect(visibleVideoTitles()).toEqual(['二十五评论', '零评论', '未知评论', '损坏统计'])
```

- [ ] **Step 3: Write failing action and selection-guard tests**

```tsx
fireEvent.click(within(row).getByRole('button', { name: '复制链接' }))
await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalledWith(video.source_url))
expect(notify).toHaveBeenCalledWith('链接已复制')

fireEvent.click(within(row).getByRole('button', { name: '复制作者名' }))
await waitFor(() => expect(window.api.writeClipboard).toHaveBeenCalledWith('作者'))
expect(notify).toHaveBeenCalledWith('作者名已复制')

fireEvent.click(within(row).getByRole('button', { name: '打开原视频' }))
await waitFor(() => expect(window.api.openVideoSource).toHaveBeenCalledWith(video.id))
```

Start with the row selected and assert each action leaves `data-selected="true"`. Mock rejected clipboard/open calls and assert understandable failure notifications.

- [ ] **Step 4: Run the focused component tests and verify RED**

Run: `npx vitest run tests/components/tasklist-source-actions.test.tsx tests/components/dom-contract.test.tsx tests/components/selection.test.tsx`

Expected: comments column/actions are absent and the new API is unused.

- [ ] **Step 5: Implement defensive stats parsing and comments sorting**

Use one parser so malformed/legacy JSON is handled consistently:

```ts
interface VideoStats { likes: number; comments: number | null }

function getVideoStats(v: VideoRow): VideoStats {
  try {
    const value = JSON.parse(v.stats || '{}') as Record<string, unknown>
    return {
      likes: typeof value.likes === 'number' && Number.isFinite(value.likes) ? value.likes : 0,
      comments: typeof value.comments === 'number' && Number.isInteger(value.comments) && value.comments >= 0
        ? value.comments
        : null
    }
  } catch {
    return { likes: 0, comments: null }
  }
}
```

Add `'comments'` to `SortKey`. For comment sorting, compare known values by direction and always place `null` after known values.

- [ ] **Step 6: Render the link subline and native controls**

Render `source_url` beneath the title with `truncate`, `title={sourceUrl}`, and a muted domain/link string. For non-filtered rows, replace the hard-coded Douyin anchor with native `button` controls that call `api.openVideoSource(v.id)` and existing `api.writeClipboard(...)`. Do not attach action handlers to spans or divs.

The main process hydrates old rows with a canonical platform URL, so display and copy work for legacy Douyin records. If a platform is unsupported or a stored value fails validation, display `—` and make copy report `作品链接不可用` rather than copying an empty value.

- [ ] **Step 7: Run component regression tests and verify GREEN**

Run: `npx vitest run tests/components/tasklist-source-actions.test.tsx tests/components/dom-contract.test.tsx tests/components/selection.test.tsx tests/components/tasklist-batch-matrix.test.tsx tests/components/batch-pause-resume.test.tsx tests/components/failure-display.test.tsx tests/components/video-delete.test.tsx`

Expected: comments/actions tests pass and all existing row-selection/batch-operation contracts remain green.

- [ ] **Step 8: Run phase-level verification**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `npm run check:css`

Expected: all commands exit 0.

- [ ] **Step 9: Commit phase 1**

```bash
git add src/renderer/src/components/TaskList.tsx tests/components
git commit -m "feat: show comments and source actions"
```

---

## Self-Review Record

- Spec coverage: comments capture/persistence/null semantics, source URL persistence/legacy fallback, HTTPS host allowlist, copy/open notifications, comments sorting, title subline, and selection guards each have a task and focused test.
- Scope boundary: FFmpeg normalization, license files, Kuaishou, and Xiaohongshu are intentionally excluded and remain phases 2–5 from the approved design.
- Placeholder scan: no `TBD`, `TODO`, “similar to”, or unspecified error-handling steps remain.
- Type consistency: Tasks 1–4 consistently use `comments`, `sourceUrl`, database `source_url`, adapter `sourceHosts`/`buildVideoUrl`, and preload `openVideoSource(id)`.
