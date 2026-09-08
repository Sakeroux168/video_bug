# Organize Level Toggles Implementation Plan

> **Execution:** Follow this plan task-by-task with `executing-plans`; use tests before implementation and verify every checkpoint. No subagents are used for this project.

**Goal:** Let users choose how deep downloaded videos are filed. Today every archived video lands in `{category}/{author}/{orientation}/{duration}` — four levels — and users report the download folder has become unusable. Each level becomes an independent setting; with none enabled, videos simply stay flat in the user's download folder.

**Architecture:** Add four booleans to `AppSettings` and pass them into `Organizer` as an `OrganizeLevels` value (the organizer is already rebuilt on settings save, so this hot-reloads). `organizeAuthor()` builds its destination path from the enabled segments only, skips AI category resolution when the category level is off, skips ffprobe orientation detection when the orientation level is off, and short-circuits to `done` when no level is enabled. Nothing else in the download → normalize → organize chain changes.

**Model route:** All tasks use `Opus 5 / High`. The path-composition and idempotence boundaries are the only real risk; there is no new I/O or platform contract.

## Invariants

- Path segments always appear in the fixed order `category / author / orientation / duration`. Disabling a middle level collapses the path; it never reorders the rest.
- With every level disabled, `organizeAuthor()` moves nothing, calls neither `resolveCategory` nor the dimension probe, marks the author `done`, and reports `moved: 0`. It must not leave the author `pending`, because a flat file can never stop looking unorganized.
- `resolveCategory` is called only when the category level is enabled. Users who turn category folders off must stop paying for the AI call.
- The dimension probe runs only when the orientation level is enabled. Persisted `video_width`/`video_height` are otherwise written back unchanged.
- Archiving stays idempotent: once a video sits below the download root it is not moved again, so repeated `organizeAll()` calls are no-ops.
- Already-archived videos are never migrated when settings change. Turning a level off leaves old files where they are (existing release red line).
- Turning levels back on later must archive the videos that accumulated flat, through the normal `organizeAll()` path.
- Upgrade behavior: an existing `settings.json` without these keys means a pre-upgrade user, who keeps all four levels enabled. A fresh install starts with all four disabled.
- Video, cover, and optional `.original.mp4` continue to move as one group with a shared stem.

---

### Task 1: Add organize level settings with upgrade-safe defaults

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/settings.ts`
- Test: `tests/settings.test.ts`

- [ ] Write failing tests: a fresh install (no `settings.json`) returns all four levels `false`; an existing `settings.json` missing the keys returns all four `true`; explicitly saved values round-trip unchanged; a corrupt file still falls back without throwing.
- [ ] Add `organizeByCategory`, `organizeByAuthor`, `organizeByOrientation`, `organizeByDuration` to `AppSettings`.
- [ ] Add all four to `DEFAULTS` as `false`, and add a separate legacy layer applied only when an existing settings file parses successfully.
- [ ] Run tests green.
- [ ] Commit: `feat: add organize level settings`.

### Task 2: Compose archive paths from enabled levels only

**Files:**
- Modify: `src/main/organizer.ts`
- Test: `tests/organizer.test.ts`

- [ ] Write failing tests for: all levels off (no move, no `resolveCategory`, no probe, author `done`); author only; orientation only; author + duration; all four on (existing four-level path unchanged); category off skipping `resolveCategory`; orientation off skipping the probe; idempotence across two `organizeAll()` runs; and cover/original still moving with the video.
- [ ] Export an `OrganizeLevels` type and accept `levels` in `OrganizerDeps`.
- [ ] Extract a private `segments()` helper returning the enabled path parts in fixed order, and a `hasAnyLevel()` guard.
- [ ] Short-circuit `organizeAuthor()` and `markAuthorPending()` on `hasAnyLevel() === false`.
- [ ] Gate `resolveCategory` and the dimension probe on their own levels.
- [ ] Run tests green.
- [ ] Commit: `feat: archive videos by selected levels`.

### Task 3: Wire settings into the organizer and report the disabled case

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/download-organize.test.ts`

- [ ] Write a failing test that saving settings rebuilds the organizer with the new levels.
- [ ] Pass the four settings into `new Organizer({ ... })` inside `reloadOrganizer()`.
- [ ] Make the manual `authors:organize` and `organize:all` handlers return an explicit reason when no level is enabled, instead of a silent `moved: 0` that reads as a failure.
- [ ] Run tests green.
- [ ] Commit: `feat: apply organize level settings`.

### Task 4: Expose the toggles in the settings panel

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/HelpPanel.tsx`
- Test: `tests/components/settings-panel.test.tsx`
- Modify: `scripts/check-css.mjs`

- [ ] Write failing component tests: four independent checkboxes render current state, toggling one calls save with only that key changed, and a hint appears when all four are unchecked.
- [ ] Add the checkbox group with static Tailwind class names only — no dynamic class composition, per the existing CSS canary rule.
- [ ] State plainly in the panel that changing these affects new downloads only and that already-filed videos are not moved.
- [ ] Update the built-in help page to match.
- [ ] Register any new critical class names in `scripts/check-css.mjs`.
- [ ] Run tests green, then `npm run check:css`.
- [ ] Commit: `feat: choose archive folder levels in settings`.

### Task 5: Full verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run check:css`
- [ ] `npm run check:licenses`
- [ ] `npm run verify`
- [ ] Launch the app in debug mode and confirm by eye: a fresh profile files nothing, enabling author-only produces a single level, and re-enabling all four restores the original layout.
- [ ] Record results in `docs/验收记录-2026-09-07-归档层级开关.md`.
- [ ] Commit: `docs: record organize level acceptance`.
