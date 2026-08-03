# 验收记录

验收日期：2026-08-03
验收环境：Windows 11、Python 3.12.10、Node.js/npm（仓库现有环境）

## 自动化验证

| 检查项 | 命令 | 实际结果 |
|---|---|---|
| Python 测试 | `.venv\Scripts\python.exe -m pytest -q` | 26 passed |
| 核心模块覆盖率 | `.venv\Scripts\python.exe -m pytest --cov=agent --cov=core --cov=tools --cov-report=term-missing -q` | 1444 条语句，88% 覆盖率 |
| Python 语法编译 | `.venv\Scripts\python.exe -m compileall agent core tools app.py` | 通过 |
| 框架 API 兼容性 | 检查已安装版本中 `create_agent`、`@wrap_model_call`、`@dynamic_prompt`、Checkpointer、Store 与 `interrupt`/`Command` 的导入和签名 | 通过 |
| 依赖一致性 | `.venv\\Scripts\\python.exe -m pip check` | No broken requirements found |
| 固定依赖可安装性 | `pip install --dry-run -r requirements.txt` | 所有固定版本均可解析 |
| 原有 Web 项目 | 根目录执行 `npm.cmd run build` | TypeScript 与 Vite 构建通过 |

## 真实数据验证

- arXiv 2005.11401（RAG）：8/8 个预期核心章节识别正确，准确率 100%。
- arXiv 1706.03762（Transformer）：7/7 个预期核心章节识别正确，准确率 100%。
- 语料还包含 REALM（2002.08909）、DPR（2004.04906）和 BERT（1810.04805）；来源、SHA-256、页数与清洗方法记录在 `data/CLEANING.md`。
- RAG、HITL、多轮隔离、质量子 Agent、批量对比、参考文献检查和 Streamlit 启动均有自动化用例；完整输入、预期和实际结果见 `tests/TEST_RESULTS.md`。

## 交付约束核对

- [x] 所有功能与文档改动仅位于 `paper-agent/`。
- [x] 未修改现有 `src/`、`src-tauri/`、`package.json` 或根 `README`。
- [x] `.env`、Chroma 数据、运行时文件、模型缓存和虚拟环境均被局部 `.gitignore` 排除。
- [x] 仅提交 `.env.example`，代码从环境变量读取模型 URL、密钥和模型名。
- [x] 当前分支为 `feature1`，提交历史按里程碑使用 Conventional Commits。
- [x] 原有 Tauri 项目的 Web 构建未被新增子项目破坏。

## 人工验收保留项

以下内容依赖提交者的身份或现场运行环境，不以虚构内容代填：

- README 中的运行截图。
- README 中的组员姓名、学号与实际分工。
- `docs/SUMMARY.md` 中的个人复盘和下次改进体会。
- 使用实际 LM Studio 或云端 OpenAI 兼容服务进行现场流式问答；自动化测试使用确定性测试模型，避免把外部服务可用性混入回归结果。
