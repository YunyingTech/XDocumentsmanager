# XDocuments Manager

A Windows and macOS desktop PDF document manager for PDF collections across local drives and SMB network shares.

Files stay in place. Local indexing, RapidOCR, Windows OCR, and PaddleOCR do not upload documents. MinerU is an optional external OCR service and sends selected files to the configured endpoint. See [TECHNICAL_ROADMAP.md](TECHNICAL_ROADMAP.md) for the current architecture, privacy boundaries, known limits, and delivery plan.

## Features

- 📁 **Index local folders & SMB shares** — Add UNC paths like `\\server\share\pdfs` or local paths
- 🔍 **Dual-backend search** — Bundled Elasticsearch with an embedded Tantivy fallback
- ✨ **Optional AI query expansion** — OpenAI-compatible models extract selectable search terms without receiving PDF contents
- 🧾 **Four OCR engines** — Default app-managed RapidOCR, Windows OCR, PaddleOCR, or an optional MinerU service
- 📄 **Built-in PDF viewer** — PDF.js page rendering in file-browser and search split views
- 📊 **Virtualized file table** — TanStack Virtual renders only visible rows for large collections
- 🌓 **Dark mode** — System-aware cozy gray theme
- ⚡ **Memory efficient** — Tauri 2.0 (Rust backend) uses 30–50MB idle vs Electron's 150–300MB

## Incremental processing model

Indexing is incremental by default. Each scan streams directory entries instead of collecting the full tree in memory, compares file size and nanosecond modification time, and hashes only new or changed PDFs. Search documents are updated or deleted in bounded batches. The **Full re-index** command is a separate, confirmed action that re-hashes every PDF and rebuilds both search backends.

OCR is incremental by default as well. Automatic and manual candidate lists include only indexed PDFs whose current content has not completed OCR. When a PDF's content hash changes, its previous OCR text is invalidated and the file becomes eligible again. Automatic OCR reads candidates with an ID cursor in batches of 100 and prevents duplicate passes for the same folder.

The OCR page can queue every pending PDF across all indexed folders. It continues reading 100-item cursor batches until no candidates remain, so the batch size bounds memory use without limiting the total number of files processed.

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
| OCR | RapidOCR + ONNX Runtime, Windows Runtime OCR, PaddleOCR, MinerU API |
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

RapidOCR is the default OCR engine and does not require a system Python installation or a network connection. Desktop packages include a SHA-256 verified private Python 3.11 runtime plus a complete platform wheelhouse containing pinned RapidOCR 3.9.2, ONNX Runtime 1.24.4, PyMuPDF 1.24.14, every transitive dependency, and the PP-OCRv6 small models. On first use the app automatically provisions this embedded runtime with `pip --no-index`, verifies it, and keeps it isolated in the application-data directory. **Automatic acceleration** uses DirectML on Windows x64, covering compatible NVIDIA, AMD, and Intel GPUs, and CoreML on macOS 14+ arm64. **CPU only** is available on both platforms. The status shown in the UI comes from the active provider of all three real ONNX sessions; failed acceleration falls back to CPU with a visible reason.

PaddleOCR remains available as an alternative engine and also does not require a system Python installation. Its execution device can be set to **Automatic**, **CPU**, or **NVIDIA CUDA 12.6**. CPU and CUDA packages are installed into separate managed runtimes, so changing modes cannot corrupt the working CPU environment. Automatic mode uses an installed CUDA runtime on compatible hardware and otherwise reports why it fell back to CPU.

CUDA acceleration is available on Windows x64 with an NVIDIA GPU of compute capability 7.5 or newer and a compatible NVIDIA driver. The official `paddlepaddle-gpu 3.3.1` package installs its pinned CUDA 12.6, cuDNN 9.5, cuBLAS, and related user-space runtime libraries, so a separate CUDA Toolkit is not required. The NVIDIA driver is not bundled. GPU setup is a large first-use download and needs substantially more disk space than CPU setup. Paddle's CUDA package always comes from the official `cu126` repository; other Python dependencies use the configurable primary and backup PyPI sources, which default to USTC and Tsinghua. Initial model downloads also require network access.

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

The prioritized roadmap is maintained in [TECHNICAL_ROADMAP.md](TECHNICAL_ROADMAP.md). Near-term work focuses on native text extraction for text PDFs, persistent OCR jobs, runtime resource controls, and repeatable million-file scale benchmarks.

## License

MIT
"# XDocumentsmanager" 
