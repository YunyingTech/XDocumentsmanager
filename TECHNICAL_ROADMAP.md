# XDocuments 技术路线

本文档描述 XDocuments `0.1.6` 的实际技术状态、关键数据链路和后续演进顺序。路线以本地优先、可恢复和固定资源占用为原则，面向超大规模 PDF 目录。

## 1. 产品边界

- 原始 PDF 保留在本地磁盘或网络共享中，软件只保存文件元数据、内容哈希、可检索文本和任务状态。
- RapidOCR、Windows OCR 与 PaddleOCR 在本机处理文件；选择 MinerU 时，PDF 会发送到用户配置的 MinerU 服务。
- 大模型智能搜索只发送用户输入的查询文本，用于生成候选关键词，不发送 PDF 文件或索引内容。
- 搜索和浏览不能依赖大模型可用性。模型调用失败时，用户仍可直接执行普通全文搜索。

## 2. 当前架构

```text
React 19 + TypeScript + Zustand
        | Tauri IPC / progress events
        v
Tauri 2 + Rust command layer
        |
        +-- SQLite: metadata, settings, index jobs, search history
        +-- Elasticsearch 8.17: primary full-text search
        +-- Tantivy: embedded fallback search index
        +-- Local/UNC filesystem: source PDFs and OCR output
        +-- OCR adapters: RapidOCR / Windows OCR / PaddleOCR / MinerU
        +-- OpenAI-compatible API: query term extraction only
```

主要模块：

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 桌面界面 | `src/components` | 文件浏览、搜索、PDF 预览、OCR、文件夹、任务中心和设置 |
| 前端状态 | `src/stores` | 文件、文件夹、搜索、OCR 队列和 UI 状态 |
| IPC 边界 | `src/lib/tauri.ts`、`src-tauri/src/commands` | 类型化调用、参数校验、后台任务和进度事件 |
| 索引流水线 | `src-tauri/src/indexer` | 流式遍历、变更判断、哈希、批量写入和删除对账 |
| 搜索引擎 | `src-tauri/src/search` | Elasticsearch/Tantivy 双后端、过滤、结果解析和智能查询 |
| 数据库 | `src-tauri/src/db` | SQLite 建表、迁移、WAL 与中断任务恢复 |
| OCR | `src-tauri/src/commands/ocr*.rs` | 四种 OCR 引擎、结果落盘、索引更新、进度和取消 |

## 3. 核心数据链路

### 3.1 增量索引

1. `WalkDir` 以迭代器方式遍历 PDF，不在内存中保存完整文件列表。
2. 增量模式先比较文件大小和纳秒级修改时间，只对新增或变化文件计算 MD5 内容哈希；全量重建会重新处理全部文件。
3. SQLite 记录元数据和内容哈希，搜索变更按固定批次同步到 Tantivy 与 Elasticsearch。
4. 只有目录完整遍历成功后才删除已消失文件的记录，避免临时断开的 SMB 子目录造成误删。
5. 文件内容变化时，旧 OCR 文本会失效，该文件重新进入 OCR 候选列表。
6. “索引并 OCR”和 OCR 页面的“全部待处理文件”按 ID 游标持续读取候选文件，每批 100 个，直到查询返回空批次；批次大小只限制内存占用，不限制处理总数。

当前限制：普通 PDF 的原生文本提取仍未实现。未执行 OCR 的文件主要按文件名和基础预览搜索；完整内容搜索目前依赖 OCR 结果。

### 3.2 OCR

| 引擎 | 处理位置 | 当前策略 | 主要限制 |
| --- | --- | --- | --- |
| RapidOCR（默认） | 本机 | 安装包内嵌私有 Python 3.11、完整平台 wheelhouse、RapidOCR 3.9.2 与 PP-OCRv6 small 模型，首次使用通过 `pip --no-index` 自动部署；自动模式在 Windows 使用 DirectML、macOS 使用 CoreML，并以检测、分类、识别三个实际 ONNX session 的 provider 判定是否加速，失败时回退 CPU；支持安装进度、逐页进度、日志和取消 | OCR 全流程可离线运行；支持 Windows x64 与 macOS 14+ arm64，其他平台需使用已有引擎 |
| Windows OCR | 本机 | Windows Runtime 按页识别，最多 2 个并发任务 | 仅 Windows，依赖已安装语言包 |
| PaddleOCR | 本机 | 软件托管的独立 Python Worker 单任务串行处理；支持自动、CPU、NVIDIA CUDA 12.6 三种执行模式，CPU/GPU 运行时隔离，自动模式优先使用已验证 GPU 并可回退 CPU；支持安装进度、OCR 进度和取消 | 首次安装依赖与首次下载模型需要网络；CUDA 仅支持 Windows x64、算力 7.5+ 的 NVIDIA GPU，并依赖兼容驱动 |
| MinerU | 外部服务 | 异步提交和轮询，也支持单文件同步解析 | 文件会离开本机，依赖服务可用性 |

识别结果写入用户配置的 OCR 输出目录，同时更新 SQLite 中的检索文本与 OCR 状态，并增量刷新两个搜索后端。任务中心展示排队、运行、进度、完成、失败和取消状态；“取消全部”会同时终止前端队列和已注册的后端任务。

### 3.3 搜索与大模型

普通搜索直接进入全文索引。启用智能搜索时：

1. 原始查询发送到 OpenAI-compatible `/chat/completions` 接口。
2. 模型只返回 `keywords` 和 `phrases` 结构化数组，后端清洗、去重并限制为最多 16 项。
3. 候选词默认折叠；用户可展开、取消选择后再检索。
4. 选中词以 OR 查询进入 Elasticsearch；服务不可用时自动使用 Tantivy。
5. 结果返回实际命中的候选词和模型名，界面在结果项中显示关联词，并在右侧直接预览 PDF。

大模型不负责排序、生成答案或读取文档，因此搜索结果可追溯，且模型故障不会破坏基础检索能力。

### 3.4 PDF 预览

PDF.js 在 WebView 中按页渲染文件。文件浏览和搜索共用预览组件；搜索结果采用结果列表与右侧预览的主从布局。

当前限制：预览界面仍会通过 IPC 一次读取完整 PDF，再交给 PDF.js。Rust 已提供带 64MB 上限的区间读取命令，但尚未接入 PDF.js Range Transport，因此超大 PDF 的预览内存占用仍需优化。

## 4. 稳定性与资源策略

- SQLite 使用 WAL、`busy_timeout` 和文件型临时存储，支持索引期间并发读取。
- 应用启动时把遗留的 `queued/running` 索引任务标记为中断，避免界面永久显示运行中。
- 同一文件夹只允许一个活动索引任务，数据库唯一索引提供最终约束。
- 索引和 OCR 使用固定批次或有限并发，不让内存消耗随文件总量线性增长。
- 日志按文件轮转，运行日志界面聚合应用、索引、搜索、OCR 和 Elasticsearch 状态。
- Elasticsearch 启动失败时保留 Tantivy 搜索能力；外部大模型和 OCR 服务失败时返回可操作错误。

## 5. 近期路线

### P0：补齐本地处理闭环

- [x] **RapidOCR 默认引擎、离线内嵌与自动 GPU 加速**：新增独立的 `rapidocr-runtime/directml-v2` 与 `coreml-v2` 私有运行时；Release 在构建阶段生成并校验完整平台 wheelhouse，固定 RapidOCR、ONNX Runtime、PyMuPDF、传递依赖与 PP-OCRv6 small 模型，首次使用只从安装包自动部署，不访问网络。Windows x64 使用 DirectML 覆盖 NVIDIA/AMD/Intel GPU，macOS 14+ arm64 使用 CoreML，CPU 为可靠回退。状态与日志读取三个真实 ONNX session 的 provider，结果写入 `_rapid.md` 并同步搜索索引。一次性数据库迁移把历史默认 MinerU 切换到 RapidOCR，迁移完成后不覆盖用户后续选择。
- [x] **软件托管 PaddleOCR 运行时**：Windows x64 与 macOS arm64 安装包携带经过 SHA-256 校验的独立 Python、pip、setuptools 和 wheel 引导资源；首次使用时在应用数据目录安装固定版本和完整约束的 PaddleOCR 依赖，采用临时目录、验证、原子切换和失败清理。Windows x64 额外支持官方 `cu126` 的 PaddlePaddle GPU 包，CUDA 12.6、cuDNN、cuBLAS 等用户态运行库随 Python 依赖安装，无需系统 CUDA Toolkit；CPU 与 CUDA 环境分别使用 `cpu-v3`、`cu126-v3`，界面展示实际设备、GPU/驱动信息和回退原因。NVIDIA 驱动仍由用户安装。
- **原生 PDF 文本提取**：集成稳定的 PDF 文本提取库，优先提取文本型 PDF，只把扫描页送入 OCR；保留页码与文本位置，改善搜索摘要和命中定位。
- **OCR 队列持久化**：把队列所有权从前端内存迁移到 Rust/SQLite，支持应用重启后的中断恢复、重试和统一并发控制。
- **运行时资源治理**：为 OCR 子进程、Elasticsearch 和文件读取增加磁盘空间检查、超时、并发上限与清晰的故障分类。
- **PDF 流式预览**：把现有区间读取 IPC 接入 PDF.js Range Transport，按需加载大文件并限制前端峰值内存。

P0 剩余完成标准：中途退出不会丢失 OCR 任务状态；文本型 PDF 无需 OCR 即可全文搜索；超大 PDF 预览不再一次加载完整文件。

### P1：验证超大规模能力

- 建立 100 万、1000 万文件级可重复基准，记录扫描吞吐、峰值内存、索引体积、搜索 P50/P95 和恢复耗时。
- 本地目录使用文件系统事件或 Windows USN Journal 获取变更；SMB 使用容错轮询和断线退避，定期全量对账。
- 将索引执行器统一到 Rust 后端，用有界通道管理扫描、哈希、写库和搜索同步，减少前端生命周期对任务的影响。
- 为 Elasticsearch/Tantivy 一致性增加校验、重放队列和可观测的重建流程。
- 增加页级搜索文档和命中页跳转，避免只显示文件级摘要。

### P2：可交付与企业能力

- 发布签名安装包、自动更新、数据迁移与回滚机制，扩充 Windows x64、macOS arm64 后的支持矩阵。
- 敏感配置接入 Windows Credential Manager/macOS Keychain；明确 MinerU 和模型端点的数据出站提示。
- 增加数据库备份恢复、索引重建、诊断包导出和受控日志脱敏。
- 建立中文 OCR、混合语言检索、长路径、SMB 抖动和断电恢复的端到端测试矩阵。

## 6. 工程质量门槛

合并前统一运行：

```powershell
npm run test:all
```

该命令覆盖前端单元测试与覆盖率、TypeScript/Vite 构建、Oxlint、Rust 测试，以及 RapidOCR/PaddleOCR Worker 的 Python 语法和单元测试。发布标签由 GitHub Actions 构建 Windows NSIS 与 macOS arm64 DMG，并生成 SHA-256 校验文件。

对超大规模能力的声明必须附带可重复的基准数据；新增外部服务或网络传输必须在界面和文档中明确数据边界。
