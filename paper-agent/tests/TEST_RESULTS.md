# 测试结果

测试环境：Windows 11、Python 3.12.10、PyMuPDF 1.28.0、LangChain 1.3.14、LangGraph 1.2.10、Chroma 1.5.9。执行命令：

```powershell
.venv\Scripts\python.exe -m pytest -q
```

自动化结果：`26 passed`。`pytest --cov=agent --cov=core --cov=tools` 的语句覆盖率为 `88%`（1444 条语句，175 条未覆盖）。

## 核心流程

| 编号 | 输入 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| C1 | arXiv 2005.11401 RAG PDF | 8 类核心章节识别率不低于 90% | Abstract、Introduction、Methods、Experiments、Results、Related Work、Discussion、References 全部识别，8/8 = 100% | 通过 |
| C2 | arXiv 1706.03762 Transformer PDF | 7 类核心章节识别率不低于 90% | Abstract、Introduction、Background、Model Architecture、Results、Conclusion、References 全部归一，7/7 = 100% | 通过 |
| C3 | 含 Figure/Table/公式/图片块的双章节文本 | 分片保留三类占位符和独立对象元数据 | 生成 `[FIGURE:*]`、`[TABLE:*]`、`[FORMULA:*]`，caption、页码、bbox 均保留 | 通过 |
| C4 | 两篇论文入库后查询 dense retriever | 只返回指定论文且带章节/页码/段落来源 | 返回 RAG Paper / Methods / p.1 / paragraph，context 含 `[S1]` | 通过 |
| C5 | 主 Agent 进行论文方法问答 | 必须调用检索工具并返回来源 artifact | ToolMessage 含 Passage artifact，回答含 `[S1]` | 通过 |
| C6 | 同一 thread 两轮追问、另建 thread | 同 thread 保留上下文，不同 thread 不共享对话消息 | 第二轮含首轮问答；另一 thread 的非系统消息不含首轮内容 | 通过 |
| C7 | 章节识别后启动 HITL | 确认前 Chroma 为 0，修改并确认后才入库 | interrupt 返回章节树；确认后写入分片并保留修正标题 | 通过 |
| C8 | Quality Agent 评估含方法/数据/创新证据的论文 | 分数由规则固定，理由由独立 Agent 输出 | 四维分数保持确定性结果，理由含 `[Q1]` 证据 | 通过 |
| C9 | RAG 与 Graph RAG 两篇论文 | 输出方法/数据集/指标 Markdown 表 | 正确列出 MS MARCO、HotpotQA、MRR、F1 及方法摘要 | 通过 |
| C10 | Streamlit AppTest 启动应用 | 页面无异常并显示五个工作区 | 0 exception；入库/问答/质量/对比/参考文献标签均存在 | 通过 |

## 边界与异常

| 编号 | 输入 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| E1 | 空白扫描 PDF | 提示先 OCR，不抛前端 traceback | `ScannedPaperError` 携带“请先进行 OCR”提示 | 通过 |
| E2 | `.txt` 假文件或非 PDF bytes | 明确拒绝非 PDF | 返回“仅支持 PDF”或“不是有效 PDF” | 通过 |
| E3 | 未确认直接入库 | 禁止写入 | `IngestApprovalRequired`，Chroma 条目数保持 0 | 通过 |
| E4 | 用户拒绝 HITL | 流程结束且不写入 | 状态 `rejected`，分片数 0 | 通过 |
| E5 | 空检索/极低距离阈值 | 返回空，Agent 明确“不知道” | Passage 为空；即便伪模型输出幻觉，服务层替换为固定“不知道” | 通过 |
| E6 | LLM 调用异常 | 返回友好错误 | 服务层转换为 `AgentUnavailableError`，前端仅显示配置检查提示 | 通过 |
| E7 | 参考文献混用 `[1]`、`(2)`、`4.` 且缺字段 | 报告混合编号、跳号、缺年份/出处 | 四类问题代码均产生 | 通过 |
| E8 | 选择少于 2 或多于 3 篇对比 | 拒绝执行 | 抛出用户可读 `ValueError`；前端按钮在非法数量时禁用 | 通过 |

## 结论

核心链路、HITL、多轮隔离、长期记忆、流式输出、质量子 Agent 和异常降级均由自动化测试覆盖。真实论文章节准确率定义为“正确识别的预期核心章节类别数 / 预期核心章节类别总数”，两篇实测均为 100%。
