# v0.1.8 发布前完整测试报告

- 日期：2026-09-07（UTC+08:00）
- 平台：Windows x64
- 基线提交：`af0df3b06a65c047d5f36d6f7a117c4dee4f6028`
- 测试对象：v0.1.8 源码、多文件夹索引修复、RapidOCR 256 并发配置及发布前修复。

## 自动化结果

| 检查 | 命令 | 最终结果 |
| --- | --- | --- |
| 完整默认测试链 | `npm run test:all` | 退出码 0 |
| 前端测试 | `npm run test:coverage` | 18 个文件、97 项测试通过 |
| TypeScript / Vite | `npm run build` | 通过 |
| 前端静态检查 | `npm run lint` | 通过 |
| Rust 默认测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | 72 项通过，3 项外部集成测试单独执行 |
| Python worker 语法 | `python -m py_compile src-tauri/scripts/paddle_ocr_worker.py src-tauri/scripts/rapid_ocr_worker.py` | 通过 |
| Python worker 测试 | `python -m unittest discover -s src-tauri/scripts -p "test_*.py"` | 13 项通过 |
| 实际 OCR / 搜索集成 | `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture` | 3 项全部通过 |
| Rust 静态检查 | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --quiet` | 退出码 0；使用文档中的 `TAURI_CONFIG` 测试覆盖配置 |
| 依赖审计 | `npm audit --registry=https://registry.npmjs.org --json` | 0 项漏洞 |

Clippy 通过，现有未使用代码与布局等 lint 提示保留。

合计：97 项前端测试 + 75 项 Rust 测试（含 3 项真实集成）+ 13 项 Python 测试 = **185 项通过**。

覆盖率：语句 78.17%，分支 63.39%，函数 79.38%，行 80.61%；达到项目现有门槛。

## 实际集成验证

配置 `XDOCUMENTS_WINDOWS_OCR_PDF` 为本次生成的一页测试 PDF，配置 `XDOCUMENTS_ELASTICSEARCH_HOME` 为本机 Elasticsearch 8.17.0 运行时。测试使用独立临时数据库、搜索索引及 Elasticsearch 数据目录。

1. Windows OCR 真实 PDF 识别：通过。
2. 超过 260 字符的长路径 PDF 识别：通过。
3. OCR 文本写入真实 Elasticsearch 后立即检索英文标记、中文词组：通过。

## 发布前发现和修复

- GitHub macOS 构建在原 v0.1.7 测试门槛发现 CUDA 安装测试断言仅适用于 Windows。修正后，支持 CUDA 安装的平台验证显卡算力错误，不支持的平台验证平台错误；没有跳过或删除该测试。v0.1.7 未发布，保留原标签，以 v0.1.8 继续发布。

- 真实 Elasticsearch 测试初次失败，暴露出增量写入成功但搜索刷新尚未完成的时序问题。增量 bulk 请求现使用 `refresh=wait_for`；完整重建仍集中执行最终刷新。新增无需外部服务的 HTTP 请求回归测试，真实集成复测通过。
- npm 官方审计初次发现 4 项依赖问题（3 项 high、1 项 moderate）。通过兼容版本更新锁文件涉及的 9 个依赖包，复查为 0。
- UI 中显示的版本原为 0.1.2，现与 npm、Tauri、Cargo 统一为 0.1.8，并新增版本一致性测试。

## 本次主要回归覆盖

- 多文件夹交错进度、任务中心数量、侧栏指示、文件夹状态。
- 完成/错误任务清理不影响其他任务，重启和较新快照不被旧定时器清除。
- RapidOCR 两处配置输入框、持久化、边界值、默认并发 3、最大并发 256。
- 257 文件任务队列：前 256 个运行，第 257 个等待，释放名额后继续。
- 自动 OCR 批次适配 256 并发，同时保留其他引擎的既有调度行为。

RapidOCR 高并发验证使用可控 Promise 模拟后端，验证调度与队列正确性；185 项结果不代表 256 个实际 OCR 进程的内存或吞吐压测，也不代表真实 MinerU/PaddleOCR 服务推理质量测试。

## 发布流程

GitHub Actions 的 Windows x64 与 macOS Apple Silicon 构建均在打包前执行 `npm run test:all`。两平台构建成功后才执行发布步骤，并生成安装包 SHA-256 校验文件。远程构建、上传和发布状态以对应 tag 的 Actions 记录为准。
