# XDocuments Manager

A Windows and macOS desktop PDF document manager designed for **60TB-scale** PDF collections across local drives and SMB network shares.

Files stay in place. Local indexing, Windows OCR, and PaddleOCR do not upload documents. MinerU is an optional external OCR service and sends selected files to the configured endpoint. See [TECHNICAL_ROADMAP.md](TECHNICAL_ROADMAP.md) for the current architecture, privacy boundaries, known limits, and delivery plan.

## Features

- 📁 **Index local folders & SMB shares** — Add UNC paths like `\\server\share\pdfs` or local paths
- 🔍 **Dual-backend search** — Bundled Elasticsearch with an embedded Tantivy fallback
- ✨ **Optional AI query expansion** — OpenAI-compatible models extract selectable search terms without receiving PDF contents
- 🧾 **Three OCR engines** — Local Windows OCR, local PaddleOCR, or an optional MinerU service
- 📄 **Built-in PDF viewer** — PDF.js page rendering in file-browser and search split views
- 📊 **Virtualized file table** — TanStack Virtual renders only visible rows for large collections
- 🌓 **Dark mode** — System-aware cozy gray theme
- ⚡ **Memory efficient** — Tauri 2.0 (Rust backend) uses 30–50MB idle vs Electron's 150–300MB

## Incremental processing model

Indexing is incremental by default. Each scan streams directory entries instead of collecting the full tree in memory, compares file size and nanosecond modification time, and hashes only new or changed PDFs. Search documents are updated or deleted in bounded batches. The **Full re-index** command is a separate, confirmed action that re-hashes every PDF and rebuilds both search backends.

OCR is incremental by default as well. Automatic and manual candidate lists include only indexed PDFs whose current content has not completed OCR. When a PDF's content hash changes, its previous OCR text is invalidated and the file becomes eligible again. Automatic OCR reads candidates with an ID cursor in batches of 100 and prevents duplicate passes for the same folder.

These choices keep memory proportional to directory depth and fixed batch sizes rather than total collection size. A scan still visits directory metadata to discover additions and removals when no reliable filesystem change journal is available; it does not reread unchanged PDF contents. If traversal reports an error, deletion reconciliation is skipped so a temporarily unavailable SMB subtree cannot erase valid index records.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2.0 (Rust + WebView2) |
| Frontend | React 19 + TypeScript + Tailwind CSS + Vite 8 |
| State Management | Zustand |
| Table | TanStack Table + TanStack Virtual |
| Search | Elasticsearch 8.17 with Tantivy fallback |
| PDF Viewer | PDF.js (lazy-loaded) |
| OCR | Windows Runtime OCR, PaddleOCR, MinerU API |
| AI Search | OpenAI-compatible chat completions API |

## Prerequisites

- **Node.js** 20+ and npm
- **Rust** (install from https://rustup.rs/)
- **Visual Studio 2022 Build Tools** or **MinGW-w64** (required for Rust compilation on Windows)
- **Xcode Command Line Tools** (required for Rust compilation on macOS)

### Installing Build Tools (Windows)

**Option A: Visual Studio Build Tools (Recommended for MSVC)**
```powershell
# Install via winget
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**Option B: MinGW-w64 (GNU toolchain)**
```powershell
# Download from https://winlibs.com/ and add mingw64/bin to PATH
# Then switch Rust to GNU:
rustup default stable-x86_64-pc-windows-gnu
```

**Option C: Just the Windows SDK (lighter)**
```powershell
winget install Microsoft.WindowsSDK.10.0.18362
```

## Quick Start

```bash
# Install dependencies
npm install

# Build and run the app
npm run tauri dev
```

## Build for Production

```bash
npm run tauri build
```

Windows installers are written to `src-tauri/target/release/bundle/nsis/` or `msi/`.
macOS disk images are written to `src-tauri/target/release/bundle/dmg/`.

## Project Structure

```
XDocumentsmanager/
├── src/                          # React frontend
│   ├── components/
│   │   ├── layout/              # Sidebar, MainPanel, StatusBar
│   │   ├── file-browser/        # FileTable (virtualized), Toolbar
│   │   ├── search/              # SearchBar, SearchResults
│   │   ├── viewer/              # PdfViewer (PDF.js)
│   │   ├── folders/             # FolderManager, AddFolderDialog
│   │   ├── settings/            # SettingsPanel
│   │   └── common/              # EmptyState, Toast, ConfirmDialog
│   ├── stores/                  # Zustand stores (files, folders, search, UI)
│   ├── lib/                     # Tauri IPC wrappers, formatting, constants
│   └── types/                   # Shared TypeScript interfaces
├── src-tauri/                   # Rust backend
│   ├── src/
│   │   ├── commands/            # Tauri IPC handlers (files, folders, index, search, viewer)
│   │   ├── indexer/             # walker, hasher, extractor, pipeline
│   │   ├── db/                  # SQLite schema + migrations
│   │   ├── search/              # Elasticsearch, Tantivy, and AI query expansion
│   │   ├── watcher/             # Local and network change-detection utilities
│   │   ├── smb/                 # SMB path utilities
│   │   ├── models/              # Shared Rust types
│   │   └── utils/               # Path handling, crypto, formatting
│   └── Cargo.toml
├── .cargo/config.toml           # Cargo config (rust-lld linker)
├── tailwind.config.js           # Cozy gray theme
└── package.json
```

## Database

SQLite database at `%APPDATA%/com.xdocuments.manager/xdocuments.db`:

| Table | Purpose |
|-------|---------|
| `watched_folders` | Local/SMB folders being indexed |
| `files` | One row per indexed PDF with metadata |
| `index_jobs` | Background indexing job tracking |
| `settings` | Key-value app configuration |
| `search_history` | User search queries |

Full-text documents are stored in the Elasticsearch and Tantivy indexes under the application data directory rather than in SQLite FTS5.

## Roadmap

The prioritized roadmap is maintained in [TECHNICAL_ROADMAP.md](TECHNICAL_ROADMAP.md). Near-term work focuses on a software-managed PaddleOCR runtime, native text extraction for text PDFs, persistent OCR jobs, and repeatable million-file scale benchmarks.

## License

MIT
"# XDocumentsmanager" 
