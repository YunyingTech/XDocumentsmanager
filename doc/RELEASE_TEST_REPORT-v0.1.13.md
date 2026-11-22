# v0.1.13 验证记录

验证日期：2026-11-22。实测平台：Windows x64。

## 修复内容

搜索结果的文件夹按钮以前拼接 `explorer.exe /select,...` 参数。路径包含空格等字符时，进程虽然启动成功，却可能只打开资源管理器主页。现在改用 Windows Shell 的 `SHParseDisplayName` 和 `SHOpenFolderAndSelectItems`，直接定位文件所在目录并选中文件。解析前将扩展 Windows 路径转换成 Shell 可识别的显示路径，文件可用性检查仍支持长路径。

定位在后台执行；界面显示旋转指示、阻止打开期间重复点击，并在文件移动或位置不可访问时显示路径和错误，保留结果以便重试。不改变搜索索引、数据库结构或重建条件。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 原版本真实复现 | 含中文、空格、逗号的文件路径：进程启动成功，但未进入目标文件夹并选中文件 |
| 普通路径 | 真实资源管理器进入对应目录并选中文件 |
| 中文、空格、逗号、方括号路径 | 真实资源管理器进入对应目录并选中文件 |
| Windows 扩展前缀路径 | 真实资源管理器进入对应目录并选中文件 |
| 超过 260 字符的深层路径 | 真实资源管理器进入对应目录并选中文件；检查时将 Shell 返回的 8.3 短名称还原后比较 |
| 文件已移动／空路径 | 后端返回错误，不报告成功 |
| 前端全量及覆盖率 | 25 个测试文件、125 项通过 |
| 覆盖率 | statements 81.35%、branches 69.92%、functions 80.25%、lines 83.40% |
| Rust 常规回归 | 89 项通过、5 项涉及外部环境或界面的测试默认忽略；其中 Explorer 测试另行对上述 4 类路径实际执行通过 |
| Python OCR 工作进程 | 14 项通过 |
| 更新清单 | 2 项通过 |
| TypeScript / Vite 构建 | 通过 |
| Oxlint | 通过 |
| 独立副本回滚 | 11 个原文件哈希一致，恢复版本 0.1.12；还原后的定位实现再次复现原问题，工作区保留修复 |

执行：`npm run test:all`、`python .github/scripts/test_create_update_manifest.py`，以及设置 `XDOCUMENTS_REVEAL_TEST_PATH` 后运行 `cargo test --manifest-path src-tauri/Cargo.toml reveals_existing_file_in_native_explorer -- --ignored --nocapture`，再通过 `Shell.Application` 检查实际窗口位置和所选文件。

本次未连接不可访问的网络共享或外部 AI/OCR 服务；macOS 的实际 Finder 操作未在本机手工执行，由 GitHub 构建与自动化回归验证其平台编译和常规行为。
