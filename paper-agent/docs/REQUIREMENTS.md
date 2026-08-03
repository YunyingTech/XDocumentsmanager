# 需求与验收映射

## 功能需求

| ID | 需求 | 实现位置 | 验证 |
|---|---|---|---|
| B1 | 中英文章节及编号层级识别，不使用 LLM | `tools/structure.py` | `test_structure.py`、`test_real_papers.py` |
| B2 | 章节感知滑窗；图表公式占位且 metadata 不丢失 | `tools/chunking.py` | `test_chunking.py` |
| B3 | 上传、概览、入库、RAG 问答、来源、空结果不知道 | `tools/ingest.py`、`tools/retrieval.py`、`agent/graph.py`、`app.py` | `test_ingest_hitl.py`、`test_retrieval.py`、`test_agent_graph.py` |
| B4 | 至少 2 篇真实论文的章节准确率 | `data/papers/`、`tests/test_real_papers.py` | RAG 8/8、Transformer 7/7 |
| A1 | 独立质量子 Agent，固定分数 + LLM 理由 | `agent/subagents/quality_agent.py` | `test_advanced_tools.py` |
| A2 | 2-3 篇论文方法/数据/指标 Markdown 对比 | `tools/compare.py` | `test_advanced_tools.py` |
| A3 | 参考文献切分、字段解析、格式问题 | `tools/references.py` | `test_advanced_tools.py` |
| A4 | MineU 原图展示与证据受限图片点评 | `core/figure_store.py`、`agent/subagents/figure_agent.py`、`app.py` | `test_mineru_loader.py`、`test_figure_store.py`、`test_figure_agent.py` |

## 优秀档技术需求

| 需求 | 状态 | 证据 |
|---|---|---|
| LangChain `create_agent` | 完成 | 主 Agent 和 Quality Agent 均为独立 compiled graph |
| LangGraph Checkpointer | 完成 | SQLite 默认；测试覆盖同 thread 多轮与 thread 隔离 |
| LangGraph Store 长期记忆 | 完成 | Store namespace + JSON 持久化；重启恢复测试 |
| 多会话隔离 | 完成 | Streamlit 会话切换 + thread_id checkpoint |
| 流式输出 | 完成 | `stream_ask` + AIMessageChunk + Streamlit placeholder |
| Token 中间件 | 完成 | `@wrap_model_call`、usage metadata、按 session 累计 |
| 动态提示 | 完成 | `@dynamic_prompt` 读取两个 Skill 和用户记忆 |
| HITL | 完成 | `interrupt()` 后由 `Command(resume=...)` 确认/拒绝 |
| 异常处理 | 完成 | 空、非 PDF、超限、扫描、空检索、模型错误、非法修正 |
| 数据可复核 | 完成 | 5 篇 arXiv PDF、URL、SHA-256、清洗说明 |

## 非功能需求

- **安全**：`.env` 不跟踪；Key 不硬编码；运行目录忽略。
- **可复现**：直接依赖固定版本；真实 PDF 随分支提交；pytest 无外部模型依赖。
- **可测试**：生产模型/embedding/checkpointer/store 均支持依赖注入。
- **可维护**：确定性工具与 Agent 编排分层；数据类提供明确 metadata contract。
- **兼容性**：Python 3.11+；Windows/macOS/Linux 的部署命令分别记录。

## 验收用例摘要

完整表见 `tests/TEST_RESULTS.md`。自动化结果为 34 passed、核心模块语句覆盖率 85%。外部 LLM 的答案质量取决于所选模型，不纳入离线 pytest；API 合约、工具调用、流式事件和错误降级使用可注入伪模型验证。
