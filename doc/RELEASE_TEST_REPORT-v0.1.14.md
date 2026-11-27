# v0.1.14 启动优化验证记录

验证日期：2026-11-27。实测平台：Windows x64。

## 问题与修复

日志中 Elasticsearch 的 HTTP 根端点先恢复，但主分片尚不可用，接着计数和查询出现 `503 no_shard_available_action_exception`。启动现在等待索引健康状态为 yellow 或 green、且健康请求未超时后才接入该服务。本地持久化索引就绪后即开放文档库和本地搜索，Elasticsearch 在后台启动与同步。

另一个重复启动日志包含 Tantivy `LockBusy`。现在使用单实例控制，重复启动唤醒原窗口，避免第二实例打开同一索引。

数据库此前每次启动都会扫描文件记录，检查旧时间戳格式。现在将兼容处理及完成标记放入同一事务，只处理一次；首次升级仍需要执行兼容检查。后台同步使用独立只读 SQLite WAL 连接，并回放同步期间新增、修改、文件删除及文件夹删除，完成后再切换查询。现有持久化索引符合条件时直接复用。

## 启动进度

启动页面和文档库底部状态栏显示四个实际阶段：数据库、本地索引、搜索服务启动、搜索同步，并显示累计耗时。有文档计数的阶段显示已处理/总数。进度代表完成的阶段数量，不是预计剩余时间。可选搜索服务失败时保留文档库和本地搜索。

下图是实际 Windows 桌面程序的底部状态栏截图：

![启动后台准备进度](screenshots/startup-progress-v0.1.14.png)

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 前端全量及覆盖率 | 26 个文件、130 项通过 |
| 覆盖率 | statements 81.37%、branches 70.07%、functions 80.31%、lines 83.40% |
| Rust 常规回归 | 93 项通过、7 项依赖外部服务或手动性能/桌面验证的测试默认忽略 |
| Python OCR 工作进程 | 14 项通过 |
| 更新清单 | 2 项通过 |
| TypeScript / Vite 生产构建、Oxlint | 通过 |
| Windows 调试程序构建 | 通过 |
| 真实 Elasticsearch 搜索回归 | 1,000 个 PDF、60 个内容/标题/目录/查询组合，两种搜索后端一致 |
| 真实后台同步回归 | 后台新增、修改、文件删除、文件夹删除和查询均通过；服务重启后未重建，现有本地索引元数据不变 |
| 真实桌面启动 | 首次观察到文档库可用的启动状态 elapsed_ms=241；服务后台准备，elapsed_ms=38842 时全部就绪 |
| 真实桌面重复启动 | 第二实例退出码 0；原窗口保持运行 |
| 真实桌面进度条 | 已在打开的文档库状态栏检测并截图确认 |

数据库阶段对照测试使用相同合成输入：300,000 条已索引记录，每条约 1 KB 预览，重复打开数据库并执行迁移和建索引，测量 3 次：

- 修改前：`STARTUP_BENCH documents=300000 warm_migration_ms=[902, 895, 974]`
- 修改后：`STARTUP_BENCH documents=300000 warm_migration_ms=[3, 2, 2]`

以上是数据库重复启动检查阶段，不是整个软件的启动时间。30 万条是合成数据；真实桌面验证使用另一份本机资料库（219 条）。桌面状态中的 241 ms 从后端启动状态计时开始，不含进程创建到该状态初始化之前的时间。

最终代码的真实后台测试中，服务准备耗时 31,123 ms，期间本地测试查询耗时 2 ms；此前一轮同项测试服务准备耗时 64,516 ms。耗时受缓存和机器负载影响，文档库无需等待该后台阶段。

## 执行记录

```text
npm run test:all
python .github/scripts/test_create_update_manifest.py
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml benchmark_warm_database_startup -- --ignored --nocapture
```

设置 `XDOCUMENTS_ELASTICSEARCH_HOME` 为本地已准备的 Elasticsearch runtime 后执行：

```text
cargo test --manifest-path src-tauri/Cargo.toml scoped_search_matches_real -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml background_sync_replays_changes_and_reuses_persisted_indexes -- --ignored --nocapture
```

上述检查退出码均为 0。最终代码在回放查询细化后另外执行了 Rust 全量和两项真实服务回归。桌面测试通过真实 WebView2 与 Tauri 状态接口检查提前可用、进度条、后台完成和重复实例退出。

发布流水线继续在 Windows x64 和 macOS Apple Silicon 上执行完整测试、更新清单验证及签名构建，并在 Windows 上执行两项真实 Elasticsearch 回归。本机未手工操作 macOS 桌面。
