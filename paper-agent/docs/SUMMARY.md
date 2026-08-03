# 项目总结

## 1. 完成内容

项目交付了一个独立 Python 论文阅读 Agent，覆盖 PDF 抽取、双语章节、占位分片、Chroma、带来源 RAG、HITL、质量子 Agent、批量对比、参考文献、Checkpointer、Store、流式 UI、Token 中间件和动态 Skill。现有 Tauri/Rust/React 文件未修改。

自动化测试为 29 passed，核心模块语句覆盖率 85%；两篇基准 arXiv 论文的核心章节类别识别率均为 100%，额外双栏论文通过 MineU OCR 识别 7 个核心章节和致谢，并写入 40 个分片。

## 2. 真实技术踩坑

### LangChain 中间件 API 已变化

当前安装的 LangChain 1.3.14 使用 `ModelRequest.system_message`，`system_prompt` 只是兼容属性；`@wrap_model_call` 的 handler 返回 `ModelResponse(result=[...])`。实现前通过 `inspect.signature` 和已安装源码确认，避免套用旧版装饰器签名。

### Tool 结果不能只返回文本

若检索工具只返回拼接字符串，UI 无法可靠恢复来源，服务层也无法判定“模型是否在空检索后编造”。最终使用 `response_format="content_and_artifact"`：给模型的 content 是 `[S#]` context，给应用的 artifact 是结构化 Passage。

### 流式拒答需要同时观察两类事件

只监听 token 无法在生成前知道工具是否为空；只监听 state 又没有实时文字。解决方式是 LangGraph `stream_mode=["messages", "values"]`：values 先暴露空 ToolMessage，之后抑制模型 chunk 并替换为固定“不知道”。

### Checkpointer 与长期记忆不是一回事

Checkpointer 能隔离 thread 消息，但不能自然表达“同一用户跨 thread 的已读论文”。实现分开：SQLite 保存对话/HITL，LangGraph Store 保存用户 profile，并用 JSON 原子写入保证重启恢复。测试也区分“非 SystemMessage 不串”和“长期记忆可跨会话注入”。

### Chroma metadata 只接受标量

placeholder 是嵌套对象，不能直接放入 Chroma metadata。实现将其序列化到 `placeholders_json`，检索后严格 JSON 解析并在损坏时降级为空 tuple。

### Streamlit 每次交互都会重跑脚本

HITL 不能依赖局部变量。运行时用 `st.cache_resource`，待确认结果和 ingest thread_id 放入 session_state，真正工作流状态由 Checkpointer 保存。按钮只发送 resume decision，不重新解析 PDF。

### 真实 PDF 暴露了规则误识别

BERT References 后的年份编号和 RAG 表格中的大数字最初被识别为通用章节。规则增加“References 后停止”“通用编号上限”“机构行/句号过滤”，并把 `Model Architecture` 归一到 Methods。调整由真实论文结果驱动，而不是为了合成用例。

## 3. 当前不足

- 尚未做图片视觉理解，Figure placeholder 只能回到 bbox/caption。
- 复杂双栏阅读顺序仍依赖 PDF 库。
- 参考文献字段解析是规则级，无法覆盖所有 ACL/IEEE/APA 变体。
- 离线测试验证 Agent 合约与安全边界，但没有固定某个商用 LLM 的答案质量。
- 单机 JSON Store 不适合多 worker 同时写入。

## 4. 个人复盘

TODO(作者补充)：结合本人负责模块，记录最困难的问题、实际贡献、时间分配和对 Agent 工程的理解变化。

## 5. 下次怎么改

TODO(作者补充)：从真实答辩反馈出发，列出下一版最优先的三项改进及取舍理由。

## 6. 答辩演示建议

1. 上传 RAG PDF，展示规则章节与 HITL 前 Chroma 为 0。
2. 修改一个章节标题并确认，展示分片数。
3. 连续提问“它使用什么检索器？”和“那训练方式呢？”，展示多轮和来源。
4. 用不存在的问题演示固定“不知道”。
5. 对 RAG/REALM/DPR 生成 Markdown 对比表。
6. 展示 Token 统计、切换会话和长期阅读历史。
