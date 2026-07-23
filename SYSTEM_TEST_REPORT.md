# XDocuments 系统测试报告

## 1. 测试结论

- 测试时间：2026-07-23 10:59-11:35（UTC+08:00）
- 测试对象：`main` 分支，基线提交 `f7a80aa` 加当前工作区改动
- 总体结论：**有条件通过**
- 已执行系统用例：24 项，24 项通过
- 测试中发现缺陷：1 项，已修复并通过回归
- 未关闭的 P0/P1 产品缺陷：0 项
- 外部条件未覆盖：真实 MinerU 推理服务、真实 SMB 共享、安装包升级/卸载

当前版本的本地文件管理、索引、普通搜索、AI 搜索、PDF 预览、Windows OCR、PaddleOCR、任务队列、批量取消、运行日志和数据清理流程均通过。实际 MinerU 服务未运行，因此只能确认离线状态处理和此前完成的 HTTP 契约测试，不能确认真实 MinerU 推理质量与吞吐。

## 2. 测试环境

| 项目 | 环境 |
| --- | --- |
| 操作系统 | Windows 11 家庭中文版 64 位，版本 10.0.26200 |
| 内存 | 32 GB |
| Node.js / npm | v24.14.0 / 11.9.0 |
| Rust / Cargo | 1.97.0 / 1.97.0 |
| Python | 3.12.10 |
| 桌面运行方式 | Tauri 开发模式，WebView2 CDP `127.0.0.1:9224` |
| 前端 | Vite `127.0.0.1:5173`，1280 x 800 |
| 搜索后端 | Elasticsearch 8.17.0，本地动态端口 |
| AI 搜索 | DeepSeek `deepseek-v4-flash`，连接成功 |
| Windows OCR | 可用，`zh-Hans-CN` |
| PaddleOCR | Paddle 3.3.1 / PaddleOCR 3.7.0 |
| MinerU | `127.0.0.1:8000`，测试时离线 |

测试通过真实 Tauri WebView DOM/ARIA 操作、Canvas 像素检查、Tauri IPC、临时 PDF、临时数据库记录和真实 Elasticsearch 完成。临时文件使用独立目录，结束后均已清理。

## 3. 系统测试结果

| ID | 场景 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| ST-01 | 应用启动与主界面 | 通过 | 中文界面正常，1280 x 800，无阻塞错误 |
| ST-02 | 后端健康状态 | 通过 | Elasticsearch 8.17.0 已连接；Windows OCR、PaddleOCR 可用 |
| ST-03 | 目录与文件清单 | 通过 | 原始目录 2 个，共 218 个文件；计数一致 |
| ST-04 | 分页与排序 | 通过 | 205 个文件分 11 页；日期正序/倒序、名称排序正确 |
| ST-05 | 普通全文搜索 | 通过 | `SSL证书` 返回 5 条，修复后 UI 查询耗时 114 ms |
| ST-06 | 时间显示 | 通过 | 搜索结果时间均可解析，界面未出现 `Invalid Date` |
| ST-07 | 文件字节读取边界 | 通过 | 文件头为 `%PDF-1.4`；反向范围被明确拒绝 |
| ST-08 | 搜索结果右侧 PDF 预览 | 通过 | Canvas 714 x 1010，8,526 个非白采样点；缩放至 833 x 1178；可关闭 |
| ST-09 | 大模型连接与分析 | 通过 | DeepSeek 连接成功；UI 分析约 3.2 秒返回 12 个词 |
| ST-10 | AI 关键词默认折叠与展开 | 通过 | 默认无筛选面板；点击后显示 12 个复选项 |
| ST-11 | AI 关键词搜索与命中模型 | 通过 | 返回 6 条；6 条均显示 `deepseek-v4-flash` 与命中词 |
| ST-12 | 添加目录表单校验 | 通过 | 路径为空时提交按钮禁用；填写后可提交 |
| ST-13 | 重复目录异常处理 | 通过 | UI 显示唯一约束错误，应用未崩溃，可正常关闭对话框 |
| ST-14 | “索引并 OCR”完整流程 | 通过 | 1 个 PDF 索引完成后自动进入 Windows OCR，`ocr_applied=true` |
| ST-15 | Windows OCR 结果持久化 | 通过 | 识别 `SYSTEM OCR SUCCESS 97531`，写入数据库和结果文件 |
| ST-16 | 大批 OCR 队列可见性 | 通过 | 5 个任务一次性显示；2 个运行、3 个排队，排队位置可见 |
| ST-17 | 一键取消所有 OCR | 通过 | 一次点击取消 5 项；Rust 活动任务数归零；两个 48 页任务在第 1 页停止 |
| ST-18 | PaddleOCR 真实推理 | 通过 | 单页 PDF 约 8.33 秒完成，39 字符，数据库与搜索均更新 |
| ST-19 | 运行日志界面 | 通过 | 应用/Elasticsearch 日志切换、文本筛选、暂停与实时恢复正常 |
| ST-20 | UI 移除目录 | 通过 | 确认框说明清楚；数据库记录和搜索文档删除，磁盘 PDF 未被误删 |
| ST-21 | 测试数据与配置恢复 | 通过 | 测试目录/输出为 0；OCR 引擎恢复 `paddle`；活动任务为 0 |
| ST-22 | Windows OCR 长路径 | 通过 | 超过 260 字符路径的真实 PDF OCR 通过 |
| ST-23 | 真实 Elasticsearch OCR 持久化 | 通过 | OCR 文本写入真实 Elasticsearch 后可检索 |
| ST-24 | 最终自动化回归 | 通过 | 前端、Rust、Python、构建与 lint 全部通过 |

## 4. 自动化质量门禁

| 检查 | 结果 |
| --- | --- |
| Vitest | 11 个测试文件，40/40 通过 |
| Rust 默认测试 | 39 通过，3 项外部测试默认忽略 |
| Rust 外部真实测试 | 3/3 通过：Windows OCR、长路径 OCR、Elasticsearch |
| Python 测试 | 2/2 通过 |
| 前端覆盖率 | Statements 78.20%，Branches 56.55%，Functions 78.86%，Lines 79.88% |
| TypeScript / Vite 构建 | 通过 |
| Oxlint | 通过 |
| Cargo Clippy | 退出码 0，存在既有 warning |
| npm audit | 0 个漏洞 |
| `git diff --check` | 通过；仅有 Windows 行尾提示 |

完整可重复命令：

```powershell
npm run test:all
$env:XDOCUMENTS_WINDOWS_OCR_PDF='<real-pdf-path>'
$env:XDOCUMENTS_ELASTICSEARCH_HOME='<elasticsearch-runtime-path>'
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
npm audit
```

## 5. 缺陷与修复

### SYS-001：AI 关键词搜索固定返回 0 条

- 严重度：高
- 状态：已修复、已回归
- 现象：普通查询 `SSL证书` 命中 5 条，但同一个词作为 AI 关键词时命中 0 条。
- 根因：AI 词被构造成带双引号的短语查询，例如 `"SSL证书"`。Elasticsearch 的 n-gram 分词器对该短语查询无命中。
- 修复：在 `src-tauri/src/commands/search.rs` 中改为转义后的分组 OR 查询，例如 `(SSL证书) | (TLS证书)`，同时转义查询运算符。
- 回归证据：后端搜索测试 4/4 通过；真实 UI 由 0 条恢复为 6 条，结果均展示模型和命中词。

## 6. 未覆盖与风险

1. **真实 MinerU 推理未执行**：服务端口 `8000` 离线。应用能正确显示离线，HTTP 契约在本地替身服务中已验证，但真实模型质量、耗时和服务端任务取消不在本报告结论内。
2. **真实 SMB 未执行**：没有可用网络共享和独立凭据，未验证断网重连、权限过期和超大共享扫描。
3. **安装包未执行**：验证了生产前端构建和开发版桌面运行，未执行 MSI/NSIS 安装、升级、卸载与签名测试。
4. **格式债务**：`cargo fmt --check` 会因仓库既有 Rust 格式问题失败；未进行全仓格式化以避免无关改动。
5. **静态警告**：Clippy 无错误，但仍有未使用代码、冗余闭包和参数过多等既有 warning，建议单独治理。

## 7. 最终状态

- 用户原始目录：`数科` 205 个文件、`制度` 13 个文件
- 总文件数：218
- Elasticsearch：已连接
- OCR 设置：已恢复为 `paddle`
- 临时测试目录：不存在
- 临时 OCR 输出：0 个
- 测试关键词 `97531`：0 条残留结果
- 活动 OCR 任务：0
- Tauri 开发应用：仍在运行

