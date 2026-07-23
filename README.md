# XDocuments Manager

A Windows desktop PDF document manager designed to handle **60TB-scale** PDF collections across local drives and SMB network shares — **without uploading any files**.

Files stay in place. The app indexes metadata and extracted text for browsing, searching, and viewing.

## Features

- 📁 **Index local folders & SMB shares** — Add UNC paths like `\\server\share\pdfs` or local paths
- 🔍 **Full-text search** — SQLite FTS5 (Phase 1) → Tantivy (Phase 2) for sub-100ms search across millions of PDFs
- 📄 **Built-in PDF viewer** — PDF.js with lazy loading and byte-range streaming for large files
- 📊 **Virtualized file table** — TanStack Virtual renders only visible rows, handles millions of entries
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
| Search | SQLite FTS5 (Phase 1), Tantivy (Phase 2) |
| PDF Viewer | PDF.js (lazy-loaded) |
| PDF Extraction | pdfium-render (Phase 2) |

## Prerequisites

- **Node.js** 20+ and npm
- **Rust** (install from https://rustup.rs/)
- **Visual Studio 2022 Build Tools** or **MinGW-w64** (required for Rust compilation on Windows)

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

The installer will be at `src-tauri/target/release/bundle/msi/`.

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
│   │   ├── search/              # Tantivy integration (Phase 2)
│   │   ├── watcher/             # File system watchers (Phase 2)
│   │   ├── smb/                 # SMB utilities (Phase 2)
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
| `files_fts` | FTS5 virtual table for full-text search |
| `index_jobs` | Background indexing job tracking |
| `settings` | Key-value app configuration |
| `search_history` | User search queries |
| `tags` / `file_tags` | User-defined tags (Phase 3) |

## Roadmap

### Phase 1 ✅ (Current)
- [x] Local folder indexing
- [x] SQLite FTS5 search
- [x] PDF.js viewer
- [x] Virtualized file browser
- [x] Folder management UI

### Phase 2 (Next)
- [ ] pdfium-render text extraction
- [ ] Tantivy full-text search engine
- [ ] SMB share support with credential management
- [ ] File system watchers (notify + polling)
- [ ] Advanced query parser (AND/OR/NOT/phrase/field filters)
- [ ] Background indexing with progress events

### Phase 3 (Future)
- [ ] OCR (Tesseract) for scanned PDFs
- [ ] Streaming PDF viewer for large files
- [ ] Tags and collections
- [ ] CJK tokenization
- [ ] Windows MSI installer

## License

MIT
"# XDocumentsmanager" 
