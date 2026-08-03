# 分析报告

## 1. 问题拆解

论文阅读不是单一摘要任务，而是五类不同约束的问题：

1. PDF 版面与文本噪声需要确定性清洗。
2. 章节是后续分片、来源和评估的结构边界，不能交给随机模型。
3. RAG 必须可追溯，并在无证据时拒答。
4. 多轮指代需要会话状态，但用户阅读史又需要跨会话共享。
5. 入库会形成长期状态，应在人可见、可修改的节点审批。

因此系统把 ingestion graph 和 conversational agent 分开：前者是有副作用的受控状态机，后者是可流式读取的工具 Agent。

## 2. 方案比较

### 章节识别

- LLM：召回高但不可重复、成本高、页码/字符位置不可靠。
- 纯目录解析：很多 arXiv PDF 没有可用 TOC。
- 当前方案：标准章节正则 + 编号标题规则 + 误识别过滤。可复现并保留 offset，真实 RAG/Transformer 样本达到 100% 核心类别准确率。

### 向量库

- FAISS：轻量，但 metadata filter 和持久管理需额外实现。
- Elasticsearch：现有桌面项目已有，但会耦合 Rust/Tauri 运行时。
- Chroma：单机持久化、metadata filter 和 Python API 足够，满足自包含要求。

### 状态

- 只用 Streamlit session_state：浏览器刷新或进程重启后丢失，无法满足多轮持久。
- 只用 Checkpointer：适合 thread 消息，不适合用户跨 thread 偏好查询。
- 当前方案：SQLite Checkpointer 管会话/HITL，LangGraph Store + JSON 管用户长期记忆。

## 3. 测试数据选择

RAG、REALM、DPR 是同主题检索增强样本，可用于方法演进对比；Transformer 和 BERT 提供不同章节写法与复杂排版。5 篇均来自 arXiv 原始 PDF，单文件最大约 2.2 MB，便于仓库复核和课堂离线演示。

真实章节准确率测试选择 RAG 和 Transformer，因为两者公开章节结构明确且覆盖 Methods/Results/Discussion/Background 等多种别名。预期集合由论文正文标题人工核对，不以算法输出反推期望。

## 4. 质量与可靠性指标

| 指标 | 当前结果 | 说明 |
|---|---:|---|
| 自动化测试 | 29 passed | 不依赖外部模型/API；另用真实双栏 PDF 验证 MineU OCR |
| 核心模块语句覆盖率 | 88% | agent/core/tools 合计 |
| RAG 核心章节准确率 | 100% (8/8) | 测试定义见 DESIGN |
| Transformer 核心章节准确率 | 100% (7/7) | Background 归一为 Related Work |
| HITL 未确认写入数 | 0 | 自动化断言 Chroma count |
| 空检索幻觉泄漏 | 0 | 服务层覆盖测试模型的幻觉文本 |

测试覆盖不是答案正确率。真实 LLM 的语言质量仍应通过人工问题集评估，但事实范围由检索 artifact 和拒答逻辑约束。

## 5. 性能分析

- PDF 抽取和章节规则是线性扫描，复杂度约 O(n)。
- 分片按章节/段落单次遍历；overlap 增加约 15% 文本量。
- Embedding 是首次入库的主要耗时；本地模型批量 encode，Chroma upsert 一次写入全部 chunk。
- 检索由 HNSW cosine query 完成，top-k 默认 5。
- SQLite Checkpointer 和 JSON memory 适用于单进程课程演示。高并发需连接池和服务型 Store。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 双栏/公式排版破坏阅读顺序 | PyMuPDF sort + pdfplumber fallback；保留页码；文档中声明限制 |
| 扫描件无文本 | 阈值检测并要求先 OCR，不生成空向量 |
| 模型不调用检索 | system prompt +工具说明；论文事实问答测试工具调用 |
| 空检索后模型编造 | 服务层从 ToolMessage artifact 检测并强制未知回答 |
| 用户误确认章节 | data editor 可修改；字段严格验证；重新入库覆盖旧 chunk |
| Key 泄漏 | 环境变量；运行状态不保存 Key；`.env` ignore |
| embedding 变更导致维度冲突 | DEPLOY 要求删除旧 collection 并重建 |

## 7. 后续量化方向

- 建立 50-100 个带人工金标准来源的 QA 集，评估 Recall@k、citation precision 和拒答准确率。
- 对双栏、中文期刊、附录型论文分别建立章节识别集。
- 参考文献解析增加 DOI/Crossref 核验，但保持网络失败可降级。
- 用多进程安全的 Postgres Checkpointer/Store 替换单机持久层。
