# Video Normalization Implementation Plan

> **Execution:** Follow this plan task-by-task with `executing-plans`; use tests before implementation and verify every checkpoint. No subagents are used for this project.

**Goal:** Normalize newly downloaded videos to `1920×1080` landscape or `1080×1920` portrait without stretching or cropping the foreground, while preserving verified originals across normalization failures and pause/resume.

**Architecture:** Reuse the bundled `ffmpeg`/`ffprobe` resolver. Add a pure media-probe/filter-policy layer and a cancellable `VideoNormalizer`, then insert it between download validation and the existing cover/`done` transition. Persist a validated download checkpoint so pause/restart can resume normalization without re-downloading. Organizer and deletion move/remove the final video, cover, and optional original as one managed group.

**References:** [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html), [FFmpeg autorotate behavior](https://ffmpeg.org/ffmpeg.html), and [FFmpeg libx264 options](https://ffmpeg.org/ffmpeg-codecs.html).

**Model route:** Tasks 1–2 use `Sol / High` for media contracts and lifecycle design. Tasks 3–6 use `Terra / High` for cross-module implementation. Task 7 uses `Sol / XHigh` for the final safety gate.

## Invariants

- Display orientation, after rotation metadata, selects the target: `height >= width` is portrait `1080×1920`; otherwise landscape `1920×1080`.
- Foreground is scaled with preserved aspect ratio and fully visible. A centered, cropped, blurred copy fills the background. Output uses `SAR=1` and `yuv420p`.
- Compatible H.264/AAC-or-silent MP4 files already at the target display size are not transcoded.
- A normalizer failure never destroys a verified download: the original becomes the final `.mp4`, and a normalization diagnostic is persisted.
- Pause during normalization kills FFmpeg, removes only the normalized partial, and leaves the verified hidden download checkpoint for resume/restart. Cancel removes all temporary files and clears the checkpoint.
- `done` is written only after a final playable file exists. Organizer never sees a partially normalized file.
- Optional `${stem}.original.mp4` is created only when normalization actually produced a different final file. File-manager counts exclude originals.
- Software `libx264 -preset medium -crf 20` is the reliable default. Hardware encoding is an optimization and is not enabled without a successful capability probe.

---

### Task 1: Probe display media and build the no-stretch filter policy

**Files:**
- Create: `src/main/videoNormalizer.ts`
- Test: `tests/video-normalizer.test.ts`
- Test: `tests/video-normalizer-live.test.ts`

- [ ] Write failing pure tests for portrait, landscape, square, 90-degree rotation, unknown dimensions, target selection, compatible-file skip, and filter graph shape.
- [ ] Implement `probeMedia()` using the existing `findBin('ffprobe')` and JSON output for video/audio codec, coded dimensions, rotation, SAR, pixel format, container, and duration.
- [ ] Implement `displayDimensions()` and `targetDimensions()`; normalize rotation and swap width/height for quarter turns.
- [ ] Implement `isAlreadyCompatible()` requiring target display dimensions, H.264, MP4, `yuv420p`, square pixels, and AAC-or-no-audio.
- [ ] Implement `buildNormalizationFilter(target)` with two branches: low-resolution background `scale → crop → gblur → scale`, full foreground `scale:force_original_aspect_ratio=decrease`, then centered overlay, `setsar=1`, `format=yuv420p`.
- [ ] Run pure tests green, then use the real bundled FFmpeg to generate rotated/portrait/landscape fixtures and confirm probe results.
- [ ] Commit: `feat: define video normalization policy`.

### Task 2: Add a cancellable FFmpeg normalizer with output validation

**Files:**
- Modify: `src/main/videoNormalizer.ts`
- Test: `tests/video-normalizer.test.ts`
- Modify: `tests/video-normalizer-live.test.ts`

- [ ] Write failing orchestration tests for missing FFmpeg, compatible skip, software encode arguments, silent input, abort, process failure, and invalid output.
- [ ] Implement a spawn-based runner bound to `AbortSignal`; use optional audio mapping, AAC 192 kbps, H.264 software defaults, `+faststart`, and rotation metadata reset.
- [ ] Validate normalized output with ffprobe: expected display size, H.264, `yuv420p`, non-empty file, and duration within `max(0.5s, 2%)`.
- [ ] Return a typed result (`normalized`, `skipped`, `failed`, `aborted`) instead of throwing lifecycle meaning into Downloader.
- [ ] Add real FFmpeg fixtures for portrait, landscape, square, 4:3, ultrawide, low resolution, silent audio, and rotation metadata; assert target size, square pixels, and duration tolerance.
- [ ] Probe hardware encoders only as capability metadata; retain software encoding as the default until a short encode probe proves an encoder works.
- [ ] Commit: `feat: normalize videos with ffmpeg`.

### Task 3: Add settings and additive persistence

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/settings.ts`
- Modify: `src/main/db.ts`
- Modify: `tests/settings.test.ts`
- Modify: `tests/db.test.ts`
- Modify explicit `VideoRow` fixtures in tests

- [ ] Add failing tests for defaults `normalizeVideo: true`, `keepOriginalVideo: false`, settings merge/save, and old-database migration.
- [ ] Add `videos.original_path TEXT` and `videos.normalization_error TEXT` additively; extend `VideoRow` and `setVideoStatus`.
- [ ] Extend `AppSettings` with the two booleans and ensure old `settings.json` files inherit defaults.
- [ ] Update explicit typed fixtures mechanically; do not weaken `VideoRow` types.
- [ ] Run settings/database/type tests green.
- [ ] Commit: `feat: persist normalization settings and originals`.

### Task 4: Integrate atomic normalization into Downloader

**Files:**
- Modify: `src/main/downloader.ts`
- Modify: `src/main/index.ts`
- Modify: `tests/downloader.test.ts`
- Modify: `tests/recovery.test.ts`

- [ ] Write failing tests for normalized success, compatible skip, unknown/failed fallback, keep-original on/off, output validation failure, cover-after-normalization, and final DB fields.
- [ ] Download into a hidden deterministic checkpoint and persist `local_path` only after source validation; on retry/restart, validate and reuse that checkpoint.
- [ ] Run `VideoNormalizer` before cover download and before `done`; atomically promote normalized output or verified original to the final MP4.
- [ ] On successful normalization with keep-original enabled, promote the source to `${stem}.original.mp4`; otherwise remove it only after final promotion succeeds.
- [ ] On normalizer failure, promote the verified source as final and persist `normalization_error`; do not mark the download failed.
- [ ] On pause, preserve the source checkpoint and remove normalized partial; on resume/restart reuse it. On cancel/delete, remove both and clear `local_path`.
- [ ] Keep existing fetch retries, address expiry, cover failure tolerance, event order, and single/global pause semantics unchanged.
- [ ] Run downloader/recovery regression tests green.
- [ ] Commit: `feat: normalize downloads before completion`.

### Task 5: Manage final video, cover, and original as one group

**Files:**
- Modify: `src/main/organizer.ts`
- Modify: `src/main/videoDelete.ts`
- Modify: `src/main/fileManager.ts`
- Modify: `tests/organizer.test.ts`
- Modify: `tests/video-delete.test.ts`
- Modify: `tests/file-manager.test.ts`
- Modify: `tests/download-organize.test.ts`

- [ ] Write failing tests for three-file rename, shared collision stem, rollback and retry actual paths, deletion safety validation before any unlink, and missing-file tolerance.
- [ ] Extend Organizer to move `original_path` beside final video as `${stem}.original.mp4`, transactionally persist all actual paths, and include it in rollback/retry bookkeeping.
- [ ] Extend program deletion to prevalidate and remove final, cover, and original as one managed group.
- [ ] Exclude `*.original.mp4` and hidden normalization checkpoints from file counts/size while recursive folder deletion still removes them.
- [ ] Run organizer/delete/file-manager regressions green.
- [ ] Commit: `feat: manage original videos with final output`.

### Task 6: Expose non-technical settings and status

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `tests/components/settings-panel.test.tsx`
- Modify: `tests/helpers/fake-api.ts` if required by strict fixtures

- [ ] Add failing UI tests for two native checkboxes and saved settings payload.
- [ ] Add `统一输出分辨率（推荐）` default-on and dependent `保留原视频` default-off controls with plain-language help about no stretching and extra disk use.
- [ ] Keep settings layout, save validation, keyboard behavior, and existing labels stable.
- [ ] Run settings-panel and DOM regressions green.
- [ ] Commit: `feat: add video normalization settings`.

### Task 7: Final safety and release verification

- [ ] Run focused normalizer/downloader/organizer/delete/settings suites.
- [ ] Run `npm run verify` and require typecheck, all tests, production build, and CSS integrity to exit 0.
- [ ] Run real FFmpeg samples and inspect representative frames/dimensions; automated screenshots do not replace human visual acceptance.
- [ ] Build the portable package and test in a clean profile: normalize one landscape and one portrait video, pause/resume one normalization, cancel one, and verify grouped archive/delete.
- [ ] Record any environment-only warnings separately from product failures.
- [ ] Commit final test/docs adjustments, then hand off the portable EXE only after the clean-profile gate passes.

