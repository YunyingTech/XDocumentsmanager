# 部署说明

## 1. 运行要求

- Python 3.11 或更高版本，推荐 3.12。
- 本地 embedding 首次下载需要网络和约 1-3 GB 可用空间（模型及 PyTorch 环境）。
- 建议至少 8 GB RAM；使用 `BAAI/bge-m3` 时建议 16 GB。
- 一个 OpenAI 兼容 Chat Completions 服务：LM Studio、本地 vLLM/Ollama 兼容代理或云端 API。

## 2. 安装

Windows：

```powershell
cd paper-agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

macOS / Linux：

```bash
cd paper-agent
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
```

依赖文件中的所有直接依赖均固定版本。本实现已真实安装该文件，未发生依赖降级。

复杂双栏或扫描 PDF 在原生章节为空、或紧凑行内章节明显不完整时会自动调用 MineU CPU pipeline。MineU 首次运行会下载布局、OCR 和公式模型，建议至少 16 GB 内存、20 GB 可用磁盘。结果缓存于 `runtime/mineru/`，相同 PDF 会直接复用。

```dotenv
MINERU_ENABLED=true
MINERU_LANGUAGE=en
MINERU_TIMEOUT_SECONDS=1800
```

## 3. LM Studio 本地配置

1. 在 LM Studio 加载支持工具调用的 instruct 模型。
2. 开启 Local Server，确认 OpenAI 兼容地址（通常 `http://127.0.0.1:1234/v1`）。
3. 配置 `.env`：

```dotenv
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=LM-Studio-界面中显示的模型标识
LLM_TIMEOUT_SECONDS=90
```

若模型不稳定地产生工具调用，换用明确支持 function/tool calling 的模型。应用不会在模型未检索时把无来源文本当作论文证据。

## 4. Embedding 配置

### 本地（默认）

```dotenv
EMBED_BACKEND=local
EMBED_MODEL=BAAI/bge-small-zh-v1.5
```

`BAAI/bge-m3` 多语能力更强但资源占用更高，可直接替换模型名。

### API

```dotenv
EMBED_BACKEND=api
EMBED_MODEL=text-embedding-3-small
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_API_KEY=...
```

修改 embedding 模型后应删除 `chroma_db/` 并重新入库，避免同一 collection 混用不同向量维度。

## 5. 启动与端口

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```

指定端口或局域网监听：

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py --server.port 8502 --server.address 0.0.0.0
```

对外监听时应在反向代理配置身份认证和 TLS。本课程版本没有内置多租户认证，`user_id` 是记忆 namespace，不是安全身份凭据。

## 6. 运行目录

| 路径 | 内容 | 备份建议 |
|---|---|---|
| `chroma_db/` | 向量和 chunk metadata | 可重建，也可定期备份 |
| `runtime/uploads/` | 用户入库 PDF | 需要备份或制定保留周期 |
| `runtime/checkpoints.sqlite3` | 多轮与 HITL 状态 | 需要保留会话时备份 |
| `runtime/memories.json` | 长期阅读记录和偏好 | 原子写入，建议备份 |

上述路径都在 `.gitignore` 中。

## 7. 测试与健康检查

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m streamlit run app.py --server.headless true
```

pytest 不调用外部 LLM/embedding 网络：使用 HashEmbedding 和可控伪模型。手工验收需另外启动真实模型服务，完成一次上传、确认、问答与来源核对。

## 8. 常见问题

- **首次启动很慢**：本地 embedding 正在下载模型。保持网络连接，或改用 API backend。
- **模型调用失败**：核对 base URL 是否包含 `/v1`、模型标识和服务端口；应用仅显示净化错误，详细服务日志在模型端查看。
- **向量维度错误**：更换 embedding 后删除旧 Chroma 目录并重建。
- **扫描 PDF**：先用 OCR 生成文本层。本项目不会把空文本静默入库。
- **上传过大**：调整 `MAX_UPLOAD_MB`，同时评估磁盘配额和 Streamlit 上传上限。
- **Windows 文件锁**：不要同时启动多个进程写同一个 checkpoint SQLite/Chroma 目录。

## 9. Gradio 备选

如目标环境无法运行 Streamlit，可用 Gradio `Blocks` 复用 `PaperAgentService` 和 `PaperIngestionWorkflow`。必须保留 session_id、HITL resume、流式 generator 和来源 artifact；不能退化成单文本框 demo。当前依赖未包含 Gradio，因为主方案已验证可用。
