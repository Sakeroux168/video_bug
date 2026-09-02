# Duration, Cover, and Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inclusive 30-second/custom duration filtering, same-basename cover downloads, and orientation-aware paired archive folders without breaking existing data.

**Architecture:** Extend the existing normalized `VideoItem` and additive SQLite migration so duration, cover, and dimensions flow through the current scheduler and downloader. Keep filtering in `extractor.ts`, reuse the existing downloader and filename helpers for paired assets, and extend `Organizer` with metadata-first/ffprobe-fallback orientation detection. No new runtime dependency is required.

**Tech Stack:** Electron 35, React 18, TypeScript 5.6, Node built-in `fetch`/`fs`/`path`/`child_process`, `node:sqlite`, Vitest, existing `findBin('ffprobe')`.

## Global Constraints

- Reuse `Downloader`, `safeFilename`, `ensureUniqueName`, `Organizer`, additive database migration, and `findBin('ffprobe')`; do not add a duplicate networking, naming, migration, or probing library.
- Do not add a runtime dependency for behavior already available through Node/Electron or the existing project.
- Existing databases, task JSON, settings, login state, and already archived files must remain usable.
- Do not automatically move authors already marked `organize_state='done'`; only new/unarchived files use the orientation level.
- Custom duration is inclusive and requires positive integer bounds with `min <= max`; unknown duration `0` never matches `under30` or `custom`.
- Cover download failure must not turn a successfully validated MP4 into a failed video.
- New archive layout is `category/author/orientation/duration/video-and-cover`.

---

### Task 1: Inclusive duration filters and form validation

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/extractor.ts`
- Modify: `src/renderer/src/components/FilterForm.tsx`
- Test: `tests/extractor.test.ts`
- Test: `tests/components/filter-form.test.tsx`

**Interfaces:**
- Consumes: existing `Filters`, `filterVideos(items, filters)`, and `FilterForm` task submission.
- Produces: `DurationFilter = 'all' | 'under30' | 'short' | 'medium' | 'long' | 'custom'`; optional `Filters.durationMinSec` / `durationMaxSec`; `matchDuration(durSec, filter, minSec?, maxSec?)`.

- [ ] **Step 1: Add failing extractor boundary tests**

```ts
it('30秒内包含 30、排除未知0与31', () => {
  expect(matchDuration(0, 'under30')).toBe(false)
  expect(matchDuration(29, 'under30')).toBe(true)
  expect(matchDuration(30, 'under30')).toBe(true)
  expect(matchDuration(31, 'under30')).toBe(false)
})

it('自定义10-20包含两端，非法或缺边界不匹配', () => {
  expect(matchDuration(10, 'custom', 10, 20)).toBe(true)
  expect(matchDuration(20, 'custom', 10, 20)).toBe(true)
  expect(matchDuration(9, 'custom', 10, 20)).toBe(false)
  expect(matchDuration(21, 'custom', 10, 20)).toBe(false)
  expect(matchDuration(15, 'custom', 20, 10)).toBe(false)
  expect(matchDuration(15, 'custom')).toBe(false)
})
```

- [ ] **Step 2: Run extractor tests and verify RED**

Run: `npx vitest run tests/extractor.test.ts`

Expected: type/test failure because `under30` / `custom` and custom bounds are not implemented.

- [ ] **Step 3: Implement the minimal extractor/type contract**

```ts
export type DurationFilter = 'all' | 'under30' | 'short' | 'medium' | 'long' | 'custom'

export interface Filters {
  // existing fields...
  durationMinSec?: number
  durationMaxSec?: number
}

export function matchDuration(durSec: number, d: DurationFilter, minSec?: number, maxSec?: number): boolean {
  if (d === 'all') return true
  if (d === 'under30') return durSec > 0 && durSec <= 30
  if (d === 'custom') {
    if (!Number.isInteger(minSec) || !Number.isInteger(maxSec) || minSec! < 1 || maxSec! < minSec!) return false
    return durSec >= minSec! && durSec <= maxSec!
  }
  if (d === 'short') return durSec < 60
  if (d === 'medium') return durSec >= 60 && durSec <= 300
  return durSec > 300
}
```

Pass the two optional fields from `filterVideos` into `matchDuration`.

- [ ] **Step 4: Add failing form tests**

```tsx
fireEvent.change(screen.getByLabelText('时长'), { target: { value: 'custom' } })
expect(screen.getByLabelText('最短秒数')).toBeInTheDocument()
expect(screen.getByLabelText('最长秒数')).toBeInTheDocument()

fireEvent.change(screen.getByLabelText('最短秒数'), { target: { value: '10' } })
fireEvent.change(screen.getByLabelText('最长秒数'), { target: { value: '20' } })
fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '测试' } })
fireEvent.click(screen.getByRole('button', { name: '开始抓取' }))
expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
  filters: expect.objectContaining({ duration: 'custom', durationMinSec: 10, durationMaxSec: 20 })
}))
```

Also assert `20–10`, decimals, blanks, and values below 1 show `自定义时长需为正整数，且最长秒数不能小于最短秒数` and do not submit.

- [ ] **Step 5: Run form tests and verify RED**

Run: `npx vitest run tests/components/filter-form.test.tsx`

Expected: custom options/inputs are absent.

- [ ] **Step 6: Implement the form controls and validation**

Add `durationMinSec` / `durationMaxSec` string state so blank input is distinguishable from zero. Derive:

```ts
const customMin = Number(durationMinSec)
const customMax = Number(durationMaxSec)
const customDurationValid = duration !== 'custom' || (
  durationMinSec.trim() !== '' && durationMaxSec.trim() !== '' &&
  Number.isInteger(customMin) && Number.isInteger(customMax) &&
  customMin >= 1 && customMax >= customMin
)
```

Render `30秒内（≤30秒）` and `自定义` options. Render the two labeled number inputs only for custom mode, disable `开始抓取` when invalid, and include bounds in submitted filters only for custom mode.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/extractor.test.ts tests/components/filter-form.test.tsx`

Expected: both files pass.

Commit:

```bash
git add src/shared/types.ts src/main/extractor.ts src/renderer/src/components/FilterForm.tsx tests/extractor.test.ts tests/components/filter-form.test.tsx
git commit -m "feat: add custom duration filtering"
```

---

### Task 2: Persist cover and dimension metadata compatibly

**Files:**
- Modify: `src/main/adapters/types.ts`
- Modify: `src/main/adapters/douyin.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/db.ts`
- Modify: `src/main/scheduler.ts`
- Test: `tests/douyin-adapter.test.ts`
- Test: `tests/db.test.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Douyin `video.origin_cover`, `video.cover`, `video.dynamic_cover`, `video.width`, `video.height`.
- Produces: `VideoItem.coverUrl`, `width`, `height`; `VideoRow.cover_url`, `cover_path`, `video_width`, `video_height`.

- [ ] **Step 1: Add failing adapter tests**

```ts
const aweme = {
  ...AWEME,
  video: {
    ...AWEME.video,
    width: 1080,
    height: 1920,
    origin_cover: { url_list: ['https://cdn.test/origin.jpg'] },
    cover: { url_list: ['https://cdn.test/cover.jpg'] }
  }
}
expect(douyinAdapter.parseApiJson('x', { aweme_list: [aweme] })[0]).toMatchObject({
  coverUrl: 'https://cdn.test/origin.jpg', width: 1080, height: 1920
})
```

Add a second test proving fallback `cover` is used and invalid/negative dimensions become `0`.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npx vitest run tests/douyin-adapter.test.ts`

Expected: returned item lacks cover and dimensions.

- [ ] **Step 3: Extend normalized metadata parsing**

```ts
export interface VideoItem {
  // existing fields...
  coverUrl: string
  width: number
  height: number
}
```

Reuse the existing `firstUrl` helper. Select the first non-empty URL from origin, static, then dynamic cover. Normalize dimensions to positive integers or `0`.

- [ ] **Step 4: Add failing migration/persistence tests**

Create an old `videos` table without the four new columns, call `initDb`, then assert `PRAGMA table_info(videos)` contains all four. Insert a `VideoItem` and assert `listVideos` returns the exact cover URL and dimensions.

- [ ] **Step 5: Run DB tests and verify RED**

Run: `npx vitest run tests/db.test.ts`

Expected: schema columns and returned values are missing.

- [ ] **Step 6: Implement additive columns and writes**

Add schema columns and migrations:

```ts
addColumnIfMissing(db, 'videos', 'cover_url', 'TEXT')
addColumnIfMissing(db, 'videos', 'cover_path', 'TEXT')
addColumnIfMissing(db, 'videos', 'video_width', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing(db, 'videos', 'video_height', 'INTEGER NOT NULL DEFAULT 0')
```

Extend `insertVideos` and both direct scheduler insert statements to bind `coverUrl`, `width`, and `height`. Extend `setVideoStatus` patchable fields with `cover_path`, `video_width`, and `video_height`.

- [ ] **Step 7: Add a scheduler persistence assertion**

Extend the existing scheduler ingestion test to return one item containing `coverUrl`, `width`, and `height`, then query the inserted row and assert all three are preserved for pending/collected items. Add a filtered-path assertion so direct filtered inserts are also schema-consistent.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx vitest run tests/douyin-adapter.test.ts tests/db.test.ts tests/scheduler.test.ts`

Expected: all pass.

Commit:

```bash
git add src/main/adapters/types.ts src/main/adapters/douyin.ts src/shared/types.ts src/main/db.ts src/main/scheduler.ts tests/douyin-adapter.test.ts tests/db.test.ts tests/scheduler.test.ts
git commit -m "feat: persist cover and video dimensions"
```

---

### Task 3: Download and delete same-basename covers

**Files:**
- Modify: `src/main/filename.ts`
- Create: `src/main/cover.ts`
- Modify: `src/main/downloader.ts`
- Modify: `src/main/videoDelete.ts`
- Test: `tests/filename.test.ts`
- Create: `tests/cover.test.ts`
- Modify: `tests/downloader.test.ts`
- Modify: `tests/video-delete.test.ts`

**Interfaces:**
- Consumes: `VideoRow.cover_url`, existing downloader `fetchImpl`, `safeFilename`, and downloader abort signal.
- Produces: `ensureUniqueStem(dir, stem, extensions)`; `downloadCover({ url, dir, stem, fetchImpl, signal, headers }) -> Promise<string | null>`; persisted `cover_path`.

- [ ] **Step 1: Add failing paired-name tests**

```ts
writeFileSync(join(dir, '标题.mp4'), 'old')
expect(ensureUniqueStem(dir, '标题', ['.mp4', '.jpg', '.png', '.webp'])).toBe('标题_1')
rmSync(join(dir, '标题.mp4'))
writeFileSync(join(dir, '标题.webp'), 'orphan')
expect(ensureUniqueStem(dir, '标题', ['.mp4', '.jpg', '.png', '.webp'])).toBe('标题_1')
```

- [ ] **Step 2: Run filename tests and verify RED**

Run: `npx vitest run tests/filename.test.ts`

Expected: `ensureUniqueStem` is not exported.

- [ ] **Step 3: Implement `ensureUniqueStem` using the existing existence loop**

```ts
export function ensureUniqueStem(dir: string, stem: string, extensions: string[]): string {
  const occupied = (candidate: string): boolean => extensions.some(ext => existsSync(join(dir, `${candidate}${ext}`)))
  if (!occupied(stem)) return stem
  let i = 1
  while (occupied(`${stem}_${i}`)) i++
  return `${stem}_${i}`
}
```

- [ ] **Step 4: Add failing cover helper tests**

Test JPEG/PNG/WebP `Content-Type` mapping, unknown fallback to `.jpg`, non-OK/null body returning `null`, partial file cleanup on stream error, and an aborted signal rethrowing instead of being swallowed.

- [ ] **Step 5: Run cover tests and verify RED**

Run: `npx vitest run tests/cover.test.ts`

Expected: `src/main/cover.ts` does not exist.

- [ ] **Step 6: Implement cover download with built-in streams**

`downloadCover` must use `Readable.fromWeb`, `pipeline`, and `createWriteStream`, write to `${stem}.cover.part`, derive the final extension from `content-type`, rename the completed part to `${stem}${ext}`, remove partial output on failure, return `null` for ordinary cover errors, and rethrow when `signal.aborted`.

```ts
export interface DownloadCoverInput {
  url: string
  dir: string
  stem: string
  fetchImpl: typeof fetch
  signal: AbortSignal
  headers: Record<string, string>
}

export async function downloadCover(input: DownloadCoverInput): Promise<string | null> {
  const part = join(input.dir, `${input.stem}.cover.part`)
  try {
    const response = await input.fetchImpl(input.url, { signal: input.signal, headers: input.headers })
    if (!response.ok || !response.body) return null
    const ext = coverExtension(response.headers.get('content-type'))
    await pipeline(Readable.fromWeb(response.body as import('stream/web').ReadableStream, { signal: input.signal }), createWriteStream(part))
    const finalPath = join(input.dir, `${input.stem}${ext}`)
    await rename(part, finalPath)
    return finalPath
  } catch (error) {
    await rm(part, { force: true })
    if (input.signal.aborted) throw error
    return null
  }
}
```

- [ ] **Step 7: Add failing downloader integration tests**

Insert a row with a cover URL. Return MP4 bytes for the video request and image bytes with `content-type: image/webp` for the cover request. Assert:

```ts
expect(basename(row.local_path!, '.mp4')).toBe(basename(row.cover_path!, '.webp'))
expect(existsSync(row.cover_path!)).toBe(true)
```

Add tests proving an orphan cover forces a shared `_1` stem, cover HTTP failure leaves video `done` with `cover_path=null`, and pause/cancel during cover removes MP4 and `.cover.part` before the existing state transition.

- [ ] **Step 8: Integrate cover download into `Downloader`**

Before downloading, select one stem using `ensureUniqueStem(downloadDir, safeName, ['.mp4', '.jpg', '.jpeg', '.png', '.webp'])`. Use it for MP4 and cover. After MP4 validation and abort check, call `downloadCover` with the same signal and request headers. Persist `cover_path` together with `local_path`; extend abort cleanup to remove MP4, completed cover, and cover part.

```ts
const stem = ensureUniqueStem(this.settings.downloadDir, name, ['.mp4', '.jpg', '.jpeg', '.png', '.webp'])
const target = join(this.settings.downloadDir, `${stem}.mp4`)
const coverPath = row.cover_url
  ? await downloadCover({ url: row.cover_url, dir: this.settings.downloadDir, stem, fetchImpl: this.fetchImpl, signal: aborter.signal, headers })
  : null
this.db.prepare("UPDATE videos SET status='done', local_path=?, cover_path=?, file_size=?, downloaded_at=?, error=NULL WHERE id=?")
  .run(target, coverPath, size, downloadedAt, id)
```

- [ ] **Step 9: Add failing paired deletion tests**

Create safe MP4 and cover paths, put both in the row, call `deleteVideoRows`, and assert both are deleted. Add an unsafe external `cover_path` case proving it is not deleted and the DB row is retained with an error rather than silently orphaning the external file.

- [ ] **Step 10: Extend safe deletion**

Select `cover_path` with `local_path`. For each non-null path require `isPathInside(downloadDir, path)`, ignore ENOENT, collect other errors, and only delete the DB row after both managed assets are gone.

```ts
const row = db.prepare('SELECT author_id, local_path, cover_path FROM videos WHERE id = ?').get(id) as {
  author_id: number | null
  local_path: string | null
  cover_path: string | null
} | undefined
const paths = [row?.local_path, row?.cover_path].filter((path): path is string => Boolean(path))
if (paths.some(path => !isPathInside(downloadDir, path))) {
  errors.push(`删除文件失败：视频资源不在下载目录内`)
  continue
}
let failed = false
for (const path of paths) {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`删除文件失败 ${path}：${String(error)}`)
      failed = true
      break
    }
  }
}
if (failed) continue
```

- [ ] **Step 11: Run focused tests and commit**

Run: `npx vitest run tests/filename.test.ts tests/cover.test.ts tests/downloader.test.ts tests/video-delete.test.ts`

Expected: all pass.

Commit:

```bash
git add src/main/filename.ts src/main/cover.ts src/main/downloader.ts src/main/videoDelete.ts tests/filename.test.ts tests/cover.test.ts tests/downloader.test.ts tests/video-delete.test.ts
git commit -m "feat: download paired video covers"
```

---

### Task 4: Orientation-aware paired organization

**Files:**
- Create: `src/main/videoMeta.ts`
- Modify: `src/main/organizer.ts`
- Test: `tests/video-meta.test.ts`
- Modify: `tests/organizer.test.ts`

**Interfaces:**
- Consumes: `VideoRow.video_width`, `video_height`, `local_path`, `cover_path`, existing `durBucket`, `ensureUniqueStem`, and `findBin('ffprobe')`.
- Produces: `screenBucket(width, height): '竖屏' | '横屏' | '未识别'`; `probeVideoDimensions(file): Promise<{ width: number; height: number } | null>`; orientation-level paired archives.

- [ ] **Step 1: Add failing orientation/probe tests**

```ts
expect(screenBucket(1080, 1920)).toBe('竖屏')
expect(screenBucket(1080, 1080)).toBe('竖屏')
expect(screenBucket(1920, 1080)).toBe('横屏')
expect(screenBucket(0, 0)).toBe('未识别')
```

Inject an `execFile` stub into the probe helper or expose a parser for ffprobe JSON; assert valid `1920x1080`, malformed JSON, command error, and no ffprobe path behavior.

- [ ] **Step 2: Run video metadata tests and verify RED**

Run: `npx vitest run tests/video-meta.test.ts`

Expected: module does not exist.

- [ ] **Step 3: Implement the ffprobe reuse**

Use `findBin('ffprobe')` and:

```text
-v error -select_streams v:0 -show_entries stream=width,height -of json <file>
```

Parse finite positive integer width/height or return `null`. Do not add an ffprobe package.

```ts
export type VideoDimensions = { width: number; height: number }

export function screenBucket(width: number, height: number): '竖屏' | '横屏' | '未识别' {
  if (!(width > 0) || !(height > 0)) return '未识别'
  return height >= width ? '竖屏' : '横屏'
}

export async function probeVideoDimensions(file: string): Promise<VideoDimensions | null> {
  const ffprobe = findBin('ffprobe')
  if (!ffprobe) return null
  return new Promise(resolve => {
    execFile(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', file
    ], (error, stdout) => {
      if (error) { resolve(null); return }
      try {
        const data = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }
        const width = Number(data.streams?.[0]?.width ?? 0)
        const height = Number(data.streams?.[0]?.height ?? 0)
        resolve(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? { width, height } : null)
      } catch { resolve(null) }
    })
  })
}
```

- [ ] **Step 4: Add failing organizer tests for the new hierarchy**

Update existing expected directories to include `竖屏`, `横屏`, or `未识别`. Add a row with metadata `1080x1920` plus same-stem MP4/JPG and assert both move to:

```text
美食/作者/竖屏/一分钟内/<same stem>.*
```

Add horizontal, square, unknown-with-probe-fallback, unknown-with-failed-probe, destination collision, and cover-rename-failure rollback tests. Assert both DB paths update only after successful paired movement.

- [ ] **Step 5: Run organizer tests and verify RED**

Run: `npx vitest run tests/organizer.test.ts`

Expected: old duration-only directories do not match and covers are not moved.

- [ ] **Step 6: Extend `OrganizerDeps` and paired move logic**

Add an optional `probeDimensions` dependency defaulting to `probeVideoDimensions` for deterministic tests. For zero metadata, probe and persist dimensions before choosing `screenBucket`. Build destination as:

```ts
join(downloadDir, category, authorDir, screenBucket(width, height), durBucket(v.duration))
```

Use `ensureUniqueStem` with the video and cover extensions. Rename video, then cover; if cover rename fails, rename the video back to its source path before reporting the item failed. Update both paths in one SQLite transaction only after filesystem movement succeeds.

```ts
const orientation = screenBucket(width, height)
const destDir = join(this.deps.downloadDir, category, authorDir, orientation, durBucket(v.duration))
const stem = ensureUniqueStem(destDir, basename(v.local_path, extname(v.local_path)), ['.mp4', coverExt])
const destVideo = join(destDir, `${stem}.mp4`)
const destCover = v.cover_path ? join(destDir, `${stem}${coverExt}`) : null

await rename(v.local_path, destVideo)
try {
  if (v.cover_path && destCover) await rename(v.cover_path, destCover)
} catch (error) {
  await rename(destVideo, v.local_path).catch(() => undefined)
  throw error
}
db.exec('BEGIN')
try {
  db.prepare('UPDATE videos SET local_path=?, cover_path=?, video_width=?, video_height=? WHERE id=?')
    .run(destVideo, destCover, width, height, v.id)
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  if (destCover && v.cover_path) await rename(destCover, v.cover_path).catch(() => undefined)
  await rename(destVideo, v.local_path).catch(() => undefined)
  throw error
}
```

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/video-meta.test.ts tests/organizer.test.ts tests/file-manager.test.ts`

Expected: all pass; file-manager MP4 counts remain unchanged by covers.

Commit:

```bash
git add src/main/videoMeta.ts src/main/organizer.ts tests/video-meta.test.ts tests/organizer.test.ts
git commit -m "feat: organize downloads by orientation"
```

---

### Task 5: Full regression, UI acceptance, and portable build

**Files:**
- Modify only if verification exposes a feature-related regression.
- Verify: all source and test files changed in Tasks 1–4.

**Interfaces:**
- Consumes: completed duration, metadata, cover, deletion, and organizer contracts.
- Produces: a tested portable executable and a concise acceptance report.

- [ ] **Step 1: Run the complete verification gate**

Run: `npm run verify`

Expected: typecheck passes, every Vitest suite passes, production renderer/main/preload build succeeds, and CSS guard reports no missing critical class.

- [ ] **Step 2: Review the final diff for wheel reuse and scope**

Run:

```bash
git diff 785c94b..HEAD --stat
git diff 785c94b..HEAD -- package.json package-lock.json
rg -n "axios|got|sharp|fluent-ffmpeg" src package.json
```

Expected: no new dependency and no duplicate network/probe/image library.

- [ ] **Step 3: Build the portable executable**

Run: `npm run dist`

Expected: `dist/video-scraper-0.1.0-portable.exe` is produced successfully.

- [ ] **Step 4: Perform actual packaged UI acceptance without saving user settings**

Launch the new portable build in an isolated test instance. Verify the duration dropdown contains `30秒内（≤30秒）` and `自定义`; custom mode shows both inputs; invalid `20–10` blocks task creation; valid `10–20` submits both inclusive fields. Do not launch a real crawl without a separate isolated download directory.

- [ ] **Step 5: Inspect a controlled end-to-end asset fixture**

Use a temporary database/download directory and mocked local HTTP responses to run one vertical ≤60s and one horizontal >60s item through downloader plus organizer. Assert each final directory contains exactly one MP4 and one same-stem cover, and both DB paths point at the final files.

- [ ] **Step 6: Final review and commit any verification-only fixes**

If Step 1–5 require changes, follow a fresh RED/GREEN cycle for each defect and commit only those scoped fixes. Finish with `git status --short` clean and report exact test/build counts.
