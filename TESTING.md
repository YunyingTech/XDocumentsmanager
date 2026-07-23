# Testing

## Test strategy

The automated suite is split into four layers:

1. Pure unit tests cover formatting, date validation, translations, query parsing, path handling, timestamp conversion, and OCR archive parsing.
2. State tests cover Zustand stores, stale-request protection, search analysis, OCR concurrency, queue visibility, polling, and cancellation races.
3. Component tests cover task cancellation, index-and-OCR status, AI match metadata, search result selection, embedded PDF preview, page navigation, and zoom controls.
4. Rust integration-style tests use temporary SQLite databases, Tantivy indexes, files, ZIP archives, and directories without touching application data.

## Commands

Run the complete repeatable suite:

```powershell
npm run test:all
```

Run individual gates:

```powershell
npm test
npm run test:coverage
npm run build
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml
python -m py_compile src-tauri/scripts/paddle_ocr_worker.py
python -m unittest discover -s src-tauri/scripts -p "test_*.py"
```

The frontend coverage gate requires at least 75% statements, lines, and functions, plus 50% branches for the tested core surface.

Run the additional release audit:

```powershell
npm audit
$env:TAURI_CONFIG='{"bundle":{"resources":[]}}'
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --quiet
git diff --check
```

The `TAURI_CONFIG` override prevents the running bundled Elasticsearch process from locking resources while Clippy builds the Tauri application.

## Coverage matrix

| Area | Automated evidence |
| --- | --- |
| File and folder state | Pagination, sorting, stale responses, automatic selection, completion refresh |
| Search | Blank/error states, stale responses, AI terms/model forwarding, filters, Unicode snippets, result preview |
| OCR | Windows concurrency, full queue visibility, cancel one/all, incremental cursor selection, duplicate folder-pass prevention, MinerU cancellation race, polling, sync parse, settings, PaddleOCR Windows CPU compatibility |
| Indexing | Incremental metadata decisions, full-mode override, streaming directory traversal, OCR invalidation after content changes, stale-file deletion, timestamp conversion, hidden-file filtering |
| Database | Migrations, pending-OCR composite index, interrupted-job recovery, legacy timestamps, cascade and job-history behavior |
| Viewer | Full/range reads, invalid ranges, PDF load errors, navigation, zoom, real canvas rendering |
| Tauri bindings | Every exported frontend command is checked against its registered backend command name |
| Security/quality | TypeScript build, Oxlint, Clippy, npm audit, Python worker syntax, diff whitespace |

## External-service tests

Three Rust tests remain ignored by default because they require external state:

- Set `XDOCUMENTS_WINDOWS_OCR_PDF` to run real Windows OCR and long-path OCR tests.
- Set `XDOCUMENTS_ELASTICSEARCH_HOME` to run the dedicated real Elasticsearch OCR persistence test.
- MinerU and PaddleOCR service/model throughput tests require their respective runtime installations.

After setting the two environment variables, run all three ignored Rust tests with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

The default suite mocks these external services but exercises their local queueing, persistence, cancellation, and error-handling contracts.
