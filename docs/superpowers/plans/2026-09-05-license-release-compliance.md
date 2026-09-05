# License and Release Compliance Implementation Plan

> **Execution:** Follow this plan task-by-task with tests before implementation. This is a source-available release, not an OSI open-source release, and the legal text should receive lawyer review before public distribution.

**Goal:** Publish the project source for free use and modification while prohibiting sale of the software itself, and ship all notices required by the actual portable build.

**Architecture:** Apply Commons Clause License Condition v1.0 to the MIT license for project-owned code. Keep third-party programs and libraries under their original licenses. Add a deterministic source-level release checker, package the notices as external resources, and expose plain-language license/source information in the existing Help panel.

**Verified inputs:** The bundled Gyan FFmpeg 8.0.1 build declares GPL v3, `--enable-gpl`, `--enable-version3`, and `--enable-libx264`; its README identifies exact FFmpeg source commit `894da5ca7d`. Electron and React are MIT; `sherpa-onnx-node` and its Windows runtime declare Apache-2.0.

**Model route:** License contract and final gate use `Sol / High` then `Sol / XHigh`; mechanical packaging and UI wiring use `Terra / High`.

## Invariants

- The project is described as “source available”, never as OSI-approved open source.
- Users may use, modify, share, and use outputs commercially, but may not sell the software itself or a substantially unchanged renamed/repackaged service.
- The restriction applies only to project-owned code. It does not relicense Electron, React, sherpa-onnx, FFmpeg, or their dependencies.
- FFmpeg stays a separate executable invoked as a child process; the project license must not claim ownership of it.
- Every portable build contains project license, Chinese explanation, NOTICE, trademark statement, and FFmpeg GPL/build/source information.
- The source URL is `https://github.com/Sakeroux168/video_bug` unless the repository is renamed before publication.

### Task 1: Freeze the license contract with failing checks

**Files:**
- Create: `tests/license-compliance.test.ts`
- Create: `scripts/check-licenses.mjs`
- Modify: `package.json`

- [ ] Test required project files and key contract phrases.
- [ ] Test production dependency license declarations against an explicit allowlist.
- [ ] Test actual FFmpeg build information and required packaged resource mappings.
- [ ] Add `check:licenses` and include it in `verify` after the production build.

### Task 2: Add project and third-party legal materials

**Files:**
- Create: `LICENSE`
- Create: `LICENSE.zh-CN.md`
- Create: `NOTICE`
- Create: `TRADEMARKS.md`
- Create: `third_party/licenses/FFmpeg-GPLv3.txt`
- Create: `third_party/licenses/FFmpeg-BUILD-INFO.txt`
- Create: `third_party/licenses/Apache-2.0.txt`
- Create: `third_party/licenses/Electron-MIT.txt`
- Create: `third_party/licenses/React-MIT.txt`

- [ ] Apply the unmodified Commons Clause v1.0 condition to MIT with concrete Software/License/Licensor fields.
- [ ] Explain permissions and the no-sale boundary in Chinese, with English license controlling and no legal-advice disclaimer.
- [ ] Record direct runtime components, versions, sources, licenses, and separation from project restrictions.
- [ ] Copy exact upstream license/build files from the locally distributed components; do not paraphrase GPL or Apache legal text.

### Task 3: Package notices and expose them in the product

**Files:**
- Modify: `electron-builder.yml`
- Modify: `src/renderer/src/components/HelpPanel.tsx`
- Modify: `tests/components/help-panel.test.tsx`

- [ ] Package all legal materials under `resources/licenses/`.
- [ ] Add a plain-language “免费版本与许可” section with source address, no-sale rule, commercial-output permission, warranty disclaimer, and third-party notice location.
- [ ] Keep the existing non-technical Help layout and native interaction contracts unchanged.

### Task 4: Release verification

- [ ] Run license tests and checker red→green.
- [ ] Run `npm run verify` and require all checks to exit 0.
- [ ] Build the portable EXE and inspect `win-unpacked/resources/licenses/` for every required file.
- [ ] Launch the rebuilt portable EXE with an isolated user-data directory, confirm clean startup, then close all QA processes.
- [ ] Record the final artifact path, size, SHA-256, test totals, and any remaining lawyer/human-visual acceptance items.

