# Changelog

## 0.1.13 — 2026-11-22

### Fixed and improved

- Fix the folder button in search results opening Explorer Home instead of revealing the matching file. Windows now resolves the file through native Shell APIs and selects it in its containing folder.
- Support Chinese names, spaces, commas, brackets, extended Windows paths and deeply nested paths without constructing an Explorer command line.
- Run folder opening in the background, show a loading indicator, prevent repeated clicks while opening, and display an actionable error if a file has moved or its location is unavailable. Keep search results available for retry.
- Preserve existing indexes, search settings and indexed documents; no reindex is required.

### Validation

- Add regression tests for folder opening failures, retry and pending-state behavior, plus missing-file validation and an opt-in native Explorer integration check.
- Verify actual Explorer folder location and selected file for ordinary, Chinese/special-character, extended-prefix and long paths.

## 0.1.12 — 2026-11-17

### Added

- Search all fields, titles/file names only, or document content only. Combine any mode with a specific indexed folder or all folders.
- Use the existing Elasticsearch and Tantivy fields directly. No index schema, tokenizer, database migration, or index rebuild is required for these search options.

### Fixed and improved

- Reset pagination and discard stale results when the search text, mode, or folder changes; preserve selected AI terms when changing filters.
- Move search-result database reads, history writes, and snippet generation to background workers. Release the database lock before processing document text and avoid copying full document text during hydration.
- Keep title/content-only queries within their selected fields, including field-qualified input in the embedded backend.
- Replace the search hint that advertised unsupported `name:`, `ext:`, and `size:` shortcuts with a keyword hint.
- Update affected frontend tool dependencies and override the typography plugin's selector parser to resolve all eight reported npm audit findings.

### Validation

- Add stored-index compatibility checks, scope/folder combination tests, pagination and stale-request regressions.
- Add a release gate that compares 60 queries across real Elasticsearch and Tantivy on 1,000 indexed documents and verifies that the queries do not change index data.

## 0.1.10 — 2026-10-10

### Fixed

- Move database preparation, local index loading/rebuilding and search service synchronization to a startup worker so the desktop window remains responsive.
- Move runtime log reads, database-backed library/settings commands and PDF reads to blocking workers rather than the UI thread.
- Serialize runtime log polling, discard stale responses after a source switch, retain displayed logs on pause and stop polling after leaving the view.
- Bound log reads to the latest 512 KiB and truncate unusually long lines at 4,096 characters to avoid excessive IPC and rendering work.

### Changed

- Show an animated startup screen with the current initialization stage. Runtime logs remain accessible while starting or after an initialization failure.
- Show a log loading indicator and disable duplicate refreshes while a read is pending.

### Tests

- Add regression coverage for startup gating/failure, slow and overlapping log requests, source changes, pause/retry/unmount, UTF-8 log truncation and background execution.

## 0.1.9 — 2026-09-09

### Fixed

- Fix multi-folder indexing progress and completion state so concurrent folders remain independently visible and do not overwrite one another.
- Avoid rebuilding the complete Elasticsearch index on every launch. Startup now validates a synchronization marker and exact document count, rebuilding only when derived search data is stale.
- Keep Elasticsearch synchronization markers correct across concurrent index, OCR, file deletion and folder deletion updates.

### Changed

- Discover each folder's complete PDF set before processing, preload existing metadata once, hash changed files in parallel using the configured indexer thread count and commit SQLite writes in bounded batches.
- Reuse persistent RapidOCR worker processes and cache OCR engines per language, model and device, while retaining the configurable maximum of 256 concurrent workers.
- Add exact search result totals, 10/25/50/100 result page sizes, previous/next pagination and safe highlighted matches in file names and snippets.
- Add indexing phases, elapsed time, files/second, bytes/second and remaining-time estimates, plus per-task and bulk OCR ETA derived from measured progress.
- Upgrade Vitest and V8 coverage to 5.0.0, move release builds to Node.js 22 and resolve all npm audit findings.

### Tests

- Add regression coverage for pagination, highlighting, filters, exact totals, stale-response handling, Elasticsearch synchronization generations, indexing ETA, metadata skip behavior, RapidOCR engine reuse and the 256-worker scheduler limit.

## 0.1.8 — 2026-09-07

- Includes the multi-folder indexing, RapidOCR 256-worker and Elasticsearch visibility fixes prepared for 0.1.7.
- Correct the PaddleOCR CUDA installation regression test to check hardware requirements on supported platforms and the platform-specific unsupported error on macOS. Product behavior is unchanged.
- The 0.1.7 release attempt stopped at the macOS test gate and was not published. Its tag is preserved; 0.1.8 is the corrected release candidate.

## 0.1.7 — 2026-09-07

### Fixed

- Track indexing progress by job ID so indexing multiple folders no longer overwrites another folder's progress.
- Keep task-center counts, sidebar indicators and folder status badges in sync with each folder's jobs.
- Prevent a completed job's delayed cleanup from removing another running job or a newer update; wait for refreshed folder totals before clearing the completion state.

- Wait for Elasticsearch incremental writes to become searchable before reporting completion, fixing an OCR read-after-write race discovered during real integration testing. Full rebuilds retain one final refresh.

### Changed

- Increase the maximum RapidOCR parallel worker count from 8 to 256 in both settings interfaces and the scheduler. The default remains 3.
- Allow automatic RapidOCR batches to grow with the configured worker count, removing the previous 100-file batch bottleneck at higher concurrency.
- Synchronize the displayed application version with the npm, Tauri and Rust release versions.
- Refresh affected dependency-lockfile packages to resolve the four findings detected by the release-time npm audit.

### Tests and release checks

- Add multi-folder indexing, stale completion cleanup, live status UI, worker-limit persistence and 257-file queue regression tests.
- Add release-version consistency coverage.
- Run the complete automated test suite on both release-build platforms before producing installers.
