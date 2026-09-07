# Changelog

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
