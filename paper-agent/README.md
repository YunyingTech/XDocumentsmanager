# 论文阅读辅助 Agent

这是一个与仓库现有 Tauri 应用解耦的 Python 子项目，完成“上传 PDF → 规则识别章节 → 人工确认 → 分片入库 → RAG 问答”的闭环。确定性任务由本地代码完成，LLM 只负责理解问题、组织答案和生成质量评价理由。

## 已实现能力

- 中英文标准章节、编号标题和层级树识别，不使用 LLM 猜章节。
- PyMuPDF 主抽取、pdfplumber 兜底，保留页码与图片块；扫描件无文本层时提示先 OCR。
- 章节感知滑窗分片，图、表、公式转为可追溯占位符，原始 caption/bbox 单独存储。
- Chroma 持久向量库，可选本地 sentence-transformers 或 OpenAI 兼容 embedding API。
- `create_agent` 主 Agent、多工具 RAG、SQLite Checkpointer、多会话隔离和流式 token 输出。
- LangGraph `interrupt()` 章节确认：未经人工确认不能写入 Chroma。
- LangGraph Store + JSON 长期记忆，跨会话记住已读论文、问题历史和偏好。
- `@wrap_model_call` 统计每会话 prompt/completion token、耗时与估算调用数。
- `@dynamic_prompt` 运行时注入结构概览和质量评分 Skill。
- 独立质量评估子 Agent、2-3 篇论文对比、参考文献提取与格式检查。
- 空检索强制回答“不知道”，模型或工具异常只显示用户可读信息。

## 快速启动

前置条件：Python 3.11+。本项目已在 Python 3.12.10 上验证。

### Windows PowerShell

```powershell
cd paper-agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
.\.venv\Scripts\python.exe -m streamlit run app.py
```

### macOS / Linux

```bash
cd paper-agent
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
${EDITOR:-vi} .env
./.venv/bin/python -m streamlit run app.py
```

浏览器默认打开 `http://localhost:8501`。首次使用本地 embedding 会从 Hugging Face 下载模型并缓存，后续启动复用缓存。

## 模型配置

所有 URL 和密钥只放在未跟踪的 `.env`。LM Studio 示例：

```dotenv
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=qwen3-8b
EMBED_BACKEND=local
EMBED_MODEL=BAAI/bge-small-zh-v1.5
```

云端 OpenAI 兼容服务只需替换 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`。Embedding 切 API 时：

```dotenv
EMBED_BACKEND=api
EMBED_MODEL=text-embedding-3-small
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_API_KEY=your-key
```

`EMBED_BACKEND=hash` 仅用于自动化测试和显式离线降级，不建议用于真实语义检索。

## 一次完整链路

1. 在侧边栏新建或选择会话，填写稳定的用户 ID。
2. 进入“论文入库”，上传 PDF 并点击“识别章节”。
3. 检查章节标题、层级和页码；可直接编辑标题/层级/页码。
4. 点击“确认并入库”。此按钮触发 `Command(resume=...)`；确认前向量库条目数保持为 0。
5. 进入“阅读问答”，选择当前论文，提问其方法、实验或结论。
6. 回答会逐 token 出现；回答下方展开来源，核对论文、章节、页码和段落号。
7. 使用“质量评估”“批量对比”“参考文献”完成进阶分析。

检索没有达到阈值时，固定返回：

> 不知道。当前已入库论文中没有检索到足够相关的段落。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m pytest --cov=agent --cov=core --cov=tools --cov-report=term-missing -q
```

当前实测：26 项测试通过，核心模块语句覆盖率 88%。两篇真实公开论文的标准章节类别识别率均为 100%。详细输入、预期和实际结果见 [tests/TEST_RESULTS.md](tests/TEST_RESULTS.md)。

## 真实测试论文

`data/papers/` 包含 5 篇公开 arXiv PDF：RAG、REALM、DPR、Transformer、BERT。其中 RAG/REALM/DPR 是同主题批量对比样本。来源、SHA-256、页数和清洗过程见 [data/CLEANING.md](data/CLEANING.md)。

## 目录

```text
paper-agent/
├── app.py
├── agent/
│   ├── graph.py
│   ├── middleware.py
│   ├── prompts.py
│   └── subagents/quality_agent.py
├── core/
│   ├── config.py
│   ├── pdf_loader.py
│   └── store.py
├── tools/
│   ├── chunking.py
│   ├── compare.py
│   ├── ingest.py
│   ├── references.py
│   ├── retrieval.py
│   └── structure.py
├── skills/
├── data/papers/
├── tests/
└── docs/
```

## 运行数据与安全

- `.env`、`.venv/`、`chroma_db/`、`runtime/`、缓存和 coverage 均由局部 `.gitignore` 排除。
- API Key 不进入 Streamlit session、Chroma metadata、日志、Checkpointer 或长期记忆。
- `runtime/uploads/` 保存用户确认入库的 PDF，用于后续参考文献复核；生产环境需自行设置磁盘配额和备份策略。
- 上传默认限制 50 MB，可通过 `MAX_UPLOAD_MB` 调整。
- 章节修正会验证标题、层级、页码和字符位置，非法值不会进入向量库。

## 运行效果截图

- TODO(提交者补充)：上传与章节 HITL 确认截图。
- TODO(提交者补充)：流式问答与来源片段截图。
- TODO(提交者补充)：质量评估和批量对比截图。

## 组员分工

- TODO(提交者补充)：组员姓名、学号、负责模块和实际工作量。

## 进一步阅读

- [设计说明](docs/DESIGN.md)
- [需求与验收映射](docs/REQUIREMENTS.md)
- [部署说明](docs/DEPLOY.md)
- [分析报告](docs/ANALYSIS.md)
- [项目总结](docs/SUMMARY.md)
