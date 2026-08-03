"""Streamlit interface for the self-contained paper reading agent."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import streamlit as st

from agent.graph import AgentUnavailableError, PaperAgentService
from core.config import AppSettings, load_settings
from core.pdf_loader import PaperLoadError, load_pdf
from tools.compare import compare_papers
from tools.ingest import IngestionResult, PaperIngestionWorkflow, paper_id_for
from tools.references import extract_references, report_as_markdown


@dataclass(slots=True)
class AppRuntime:
    settings: AppSettings
    agent: PaperAgentService
    ingestion: PaperIngestionWorkflow


@st.cache_resource(show_spinner="正在加载论文阅读运行时…")
def get_runtime() -> AppRuntime:
    settings = load_settings()
    agent = PaperAgentService(settings)
    ingestion = PaperIngestionWorkflow(agent.vector_store, settings, agent.checkpointer)
    return AppRuntime(settings, agent, ingestion)


def main() -> None:
    st.set_page_config(page_title="论文阅读辅助 Agent", page_icon="📄", layout="wide")
    _initialize_state()
    try:
        runtime = get_runtime()
    except Exception:
        st.error("运行时初始化失败。请检查 `.env`、网络和模型配置后刷新页面。")
        st.stop()

    session_id, user_id = _render_sidebar(runtime)
    session = st.session_state.sessions[session_id]

    st.title("论文阅读辅助 Agent")
    upload_tab, chat_tab, quality_tab, compare_tab, references_tab = st.tabs(
        ["论文入库", "阅读问答", "质量评估", "批量对比", "参考文献"]
    )
    with upload_tab:
        _render_upload(runtime, session_id, user_id)
    with chat_tab:
        _render_chat(runtime, session_id, user_id, session)
    with quality_tab:
        _render_quality(runtime, session_id)
    with compare_tab:
        _render_compare(runtime)
    with references_tab:
        _render_references(runtime)


def _initialize_state() -> None:
    if "sessions" not in st.session_state:
        session_id = uuid4().hex
        st.session_state.sessions = {
            session_id: {
                "name": "阅读会话 1",
                "messages": [],
                "active_paper_id": None,
            }
        }
        st.session_state.current_session_id = session_id
    st.session_state.setdefault("user_id", "local-user")
    st.session_state.setdefault("pending_ingestion", None)


def _render_sidebar(runtime: AppRuntime) -> tuple[str, str]:
    with st.sidebar:
        st.header("会话")
        user_id = st.text_input("用户 ID", key="user_id") or "local-user"
        if st.button("新建会话", use_container_width=True):
            session_id = uuid4().hex
            st.session_state.sessions[session_id] = {
                "name": f"阅读会话 {len(st.session_state.sessions) + 1}",
                "messages": [],
                "active_paper_id": None,
            }
            st.session_state.current_session_id = session_id
            st.rerun()
        session_ids = list(st.session_state.sessions)
        labels = {
            identifier: st.session_state.sessions[identifier]["name"] for identifier in session_ids
        }
        current_index = session_ids.index(st.session_state.current_session_id)
        selected = st.selectbox(
            "当前会话",
            session_ids,
            index=current_index,
            format_func=lambda identifier: labels[identifier],
        )
        st.session_state.current_session_id = selected

        papers = runtime.agent.vector_store.list_papers()
        paper_ids = [paper["paper_id"] for paper in papers]
        title_by_id = {paper["paper_id"]: paper["title"] for paper in papers}
        current = st.session_state.sessions[selected].get("active_paper_id")
        options: list[str | None] = [None, *paper_ids]
        selected_paper = st.selectbox(
            "当前论文",
            options,
            index=options.index(current) if current in options else 0,
            format_func=lambda identifier: "全部已入库论文" if identifier is None else title_by_id[identifier],
        )
        st.session_state.sessions[selected]["active_paper_id"] = selected_paper

        usage = runtime.agent.token_usage(selected)
        st.divider()
        st.caption("当前会话用量")
        col1, col2 = st.columns(2)
        col1.metric("Prompt", usage.prompt_tokens)
        col2.metric("Completion", usage.completion_tokens)
        st.caption(f"{usage.calls} 次模型调用 · {usage.latency_seconds:.2f}s")
        if usage.estimated_calls:
            st.caption(f"其中 {usage.estimated_calls} 次为本地估算")
        st.divider()
        st.caption(f"已入库论文：{len(papers)}")
        for paper in papers:
            st.text(paper["title"])
    return selected, user_id


def _render_upload(runtime: AppRuntime, session_id: str, user_id: str) -> None:
    uploaded = st.file_uploader("上传 PDF", type=["pdf"], accept_multiple_files=False)
    title = st.text_input("论文标题（可选）")
    if uploaded and st.button("识别章节", type="primary"):
        data = uploaded.getvalue()
        if not data:
            st.warning("上传文件为空。")
        elif len(data) > runtime.settings.max_upload_mb * 1024 * 1024:
            st.error(f"PDF 超过 {runtime.settings.max_upload_mb} MB 限制。")
        else:
            paper_id = paper_id_for(data, uploaded.name)
            runtime.settings.upload_dir.mkdir(parents=True, exist_ok=True)
            path = runtime.settings.upload_dir / f"{paper_id}.pdf"
            path.write_bytes(data)
            ingest_thread = f"ingest:{session_id}:{paper_id}:{uuid4().hex[:8]}"
            with st.spinner("正在抽取文本并识别章节…"):
                result = runtime.ingestion.start(
                    path,
                    paper_id=paper_id,
                    title=title.strip() or Path(uploaded.name).stem,
                    thread_id=ingest_thread,
                )
            st.session_state.pending_ingestion = {
                "thread_id": ingest_thread,
                "result": result,
            }

    pending = st.session_state.pending_ingestion
    if not pending:
        return
    result: IngestionResult = pending["result"]
    if result.status == "failed":
        st.error(result.message)
        if st.button("清除失败任务"):
            st.session_state.pending_ingestion = None
            st.rerun()
        return
    if not result.requires_confirmation:
        st.info(result.message)
        return

    st.subheader("章节确认")
    st.info(result.message)
    editable = st.data_editor(
        list(result.sections),
        key=f"sections-{pending['thread_id']}",
        hide_index=True,
        use_container_width=True,
        disabled=["canonical", "number", "char_start"],
        column_config={
            "title": st.column_config.TextColumn("标题", required=True),
            "level": st.column_config.NumberColumn("层级", min_value=1, max_value=5, step=1),
            "page": st.column_config.NumberColumn("页码", min_value=1, step=1),
            "char_start": st.column_config.NumberColumn("字符位置"),
            "canonical": st.column_config.TextColumn("标准章节"),
            "number": st.column_config.TextColumn("编号"),
        },
    )
    confirm_col, cancel_col = st.columns([1, 1])
    if confirm_col.button("确认并入库", type="primary", use_container_width=True):
        records = editable.to_dict("records") if hasattr(editable, "to_dict") else list(editable)
        completed = runtime.ingestion.resume(
            thread_id=pending["thread_id"], confirmed=True, sections=records
        )
        if completed.status == "completed":
            runtime.agent.long_term_memory.remember_paper(user_id, completed.paper_id, completed.title)
            st.session_state.sessions[session_id]["active_paper_id"] = completed.paper_id
            st.session_state.pending_ingestion = None
            st.success(completed.message)
            st.rerun()
        else:
            st.error(completed.message)
    if cancel_col.button("取消入库", use_container_width=True):
        cancelled = runtime.ingestion.resume(thread_id=pending["thread_id"], confirmed=False)
        st.session_state.pending_ingestion = None
        st.info(cancelled.message)
        st.rerun()


def _render_chat(
    runtime: AppRuntime,
    session_id: str,
    user_id: str,
    session: dict[str, Any],
) -> None:
    for message in session["messages"]:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
            if message.get("sources"):
                _render_sources(message["sources"])
    question = st.chat_input("询问当前论文的方法、实验或结论")
    if not question:
        return
    session["messages"].append({"role": "user", "content": question})
    with st.chat_message("user"):
        st.markdown(question)
    with st.chat_message("assistant"):
        placeholder = st.empty()
        answer = ""
        sources: list[dict[str, Any]] = []
        try:
            for event in runtime.agent.stream_ask(
                question,
                thread_id=session_id,
                user_id=user_id,
                active_paper_id=session.get("active_paper_id"),
            ):
                if event.kind == "token":
                    answer += event.text
                    placeholder.markdown(answer + "▌")
                elif event.kind == "replace":
                    answer = event.text
                    placeholder.markdown(answer)
                elif event.kind == "sources":
                    sources = [asdict(source) for source in event.sources]
            placeholder.markdown(answer)
            if sources:
                _render_sources(sources)
        except (AgentUnavailableError, ValueError) as exc:
            answer = str(exc)
            placeholder.error(answer)
        except Exception:
            answer = "问答失败，请稍后重试。"
            placeholder.error(answer)
        session["messages"].append(
            {"role": "assistant", "content": answer, "sources": sources}
        )


def _render_quality(runtime: AppRuntime, session_id: str) -> None:
    papers = runtime.agent.vector_store.list_papers()
    if not papers:
        st.info("暂无已入库论文。")
        return
    options = {paper["paper_id"]: paper["title"] for paper in papers}
    paper_id = st.selectbox("评估论文", list(options), format_func=options.get, key="quality-paper")
    if st.button("开始质量评估", type="primary"):
        try:
            with st.spinner("质量子 Agent 正在分析证据…"):
                assessment = runtime.agent.quality_agent.assess(
                    runtime.agent.vector_store, paper_id, thread_id=session_id
                )
            columns = st.columns(4)
            labels = {
                "methodology": "方法论",
                "data_support": "数据支撑",
                "innovation": "创新性",
                "clarity": "清晰度",
            }
            for column, (dimension, label) in zip(columns, labels.items(), strict=True):
                column.metric(label, f"{assessment.scores[dimension]}/5")
                column.caption(assessment.reasons[dimension])
            st.markdown(f"**综合分：{assessment.overall}/5**")
            st.markdown(assessment.summary)
        except (AgentUnavailableError, ValueError) as exc:
            st.error(str(exc))
        except Exception:
            st.error("质量评估失败，请检查模型服务。")


def _render_compare(runtime: AppRuntime) -> None:
    papers = runtime.agent.vector_store.list_papers()
    options = {paper["paper_id"]: paper["title"] for paper in papers}
    selected = st.multiselect(
        "选择 2-3 篇论文",
        list(options),
        format_func=options.get,
        max_selections=3,
    )
    if st.button("生成对比表", disabled=not 2 <= len(selected) <= 3):
        try:
            st.markdown(compare_papers(runtime.agent.vector_store, selected))
        except ValueError as exc:
            st.warning(str(exc))
        except Exception:
            st.error("论文对比失败，请稍后重试。")


def _render_references(runtime: AppRuntime) -> None:
    papers = runtime.agent.vector_store.list_papers()
    if not papers:
        st.info("暂无已入库论文。")
        return
    options = {paper["paper_id"]: paper["title"] for paper in papers}
    paper_id = st.selectbox("检查论文", list(options), format_func=options.get, key="reference-paper")
    if st.button("提取并检查参考文献"):
        path = runtime.settings.upload_dir / f"{paper_id}.pdf"
        if not path.exists():
            st.warning("未找到该论文的本地 PDF，请重新上传后检查。")
            return
        try:
            document = load_pdf(path, max_size_mb=runtime.settings.max_upload_mb)
            st.markdown(report_as_markdown(extract_references(document.text)))
        except PaperLoadError as exc:
            st.error(str(exc))
        except Exception:
            st.error("参考文献检查失败，请稍后重试。")


def _render_sources(sources: list[dict[str, Any]]) -> None:
    with st.expander(f"来源片段（{len(sources)}）"):
        for index, source in enumerate(sources, start=1):
            pages = (
                str(source["page"])
                if source["page"] == source["page_end"]
                else f"{source['page']}-{source['page_end']}"
            )
            st.markdown(
                f"**S{index} · {source['paper_title']} · {source['section']} · "
                f"p.{pages} · paragraph {source['para_idx']}**"
            )
            st.caption(str(source["text"])[:900])


if __name__ == "__main__":
    main()
