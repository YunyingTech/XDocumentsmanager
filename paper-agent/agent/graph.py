"""Main LangChain agent with RAG tools, Checkpointer, and Store."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import sqlite3
from typing import Any, Iterator, Literal

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore

from agent.prompts import PAPER_AGENT_SYSTEM_PROMPT
from agent.subagents.quality_agent import QualityAgent
from agent.middleware import (
    TokenUsage,
    TokenUsageTracker,
    create_skill_prompt_middleware,
    create_token_stats_middleware,
)
from core.config import AppSettings, create_chat_model, create_embedding, load_settings
from core.store import LongTermMemory, PaperVectorStore, memory_user_id
from tools.compare import compare_papers
from tools.references import extract_references, report_as_markdown
from tools.retrieval import (
    UNKNOWN_ANSWER,
    Passage,
    passages_as_context,
    retrieve_paragraphs,
)


class AgentUnavailableError(RuntimeError):
    """A sanitized model or graph execution failure."""


@dataclass(frozen=True, slots=True)
class AgentContext:
    user_id: str
    session_id: str
    active_paper_id: str | None = None


@dataclass(frozen=True, slots=True)
class AgentAnswer:
    text: str
    sources: tuple[Passage, ...]
    message_count: int


@dataclass(frozen=True, slots=True)
class AgentStreamEvent:
    kind: Literal["token", "replace", "sources", "done"]
    text: str = ""
    sources: tuple[Passage, ...] = ()


def build_agent_tools(
    vector_store: PaperVectorStore,
    settings: AppSettings,
    quality_agent: QualityAgent,
) -> list[Any]:
    @tool("retrieve_paper_passages", response_format="content_and_artifact")
    def retrieve_tool(
        query: str,
        runtime: ToolRuntime[AgentContext],
        paper_id: str = "",
        k: int = 0,
    ) -> tuple[str, dict[str, Any]]:
        """Retrieve relevant paper paragraphs. Use for every paper-content question."""
        selected_paper = paper_id.strip() or runtime.context.active_paper_id
        passages = retrieve_paragraphs(
            vector_store,
            query,
            paper_id=selected_paper,
            k=k if 0 < k <= 10 else settings.retrieval_top_k,
            max_distance=settings.retrieval_max_distance,
        )
        if not passages:
            return UNKNOWN_ANSWER, {"kind": "retrieval", "passages": []}
        return passages_as_context(passages), {
            "kind": "retrieval",
            "passages": [asdict(passage) for passage in passages],
        }

    @tool("list_ingested_papers")
    def list_papers_tool() -> str:
        """List paper IDs and titles currently available for reading or comparison."""
        papers = vector_store.list_papers()
        if not papers:
            return "当前没有已入库论文。"
        return "\n".join(f"- {paper['paper_id']}: {paper['title']}" for paper in papers)

    @tool("get_reading_history")
    def reading_history_tool(runtime: ToolRuntime[AgentContext]) -> dict[str, Any]:
        """Return this user's long-term paper history and reading preferences."""
        if runtime.store is None:
            return {"read_papers": {}, "preferences": {}, "history": []}
        item = runtime.store.get(("users", memory_user_id(runtime.context.user_id)), "profile")
        return item.value if item else {"read_papers": {}, "preferences": {}, "history": []}

    @tool("assess_quality")
    def assess_quality_tool(
        paper_id: str,
        runtime: ToolRuntime[AgentContext],
    ) -> dict[str, Any]:
        """Run the independent quality sub-agent for one indexed paper."""
        selected_paper = paper_id.strip() or runtime.context.active_paper_id
        if not selected_paper:
            return {"error": "请先选择要评估的论文。"}
        return quality_agent.assess(
            vector_store,
            selected_paper,
            thread_id=runtime.context.session_id,
        ).to_dict()

    @tool("compare_indexed_papers")
    def compare_papers_tool(paper_ids: list[str]) -> str:
        """Compare methods, datasets, and metrics across two or three indexed papers."""
        return compare_papers(vector_store, paper_ids)

    @tool("check_reference_format")
    def check_references_tool(paper_id: str) -> str:
        """Extract and check the reference list of an indexed paper."""
        records = vector_store.records_for_paper(paper_id)
        reference_text = "\n\n".join(
            str(record["document"])
            for record in records
            if str(record["metadata"].get("section_canonical")) == "references"
        )
        if not reference_text:
            return "未识别到参考文献章节。"
        return report_as_markdown(extract_references("References\n" + reference_text))

    return [
        retrieve_tool,
        list_papers_tool,
        reading_history_tool,
        assess_quality_tool,
        compare_papers_tool,
        check_references_tool,
    ]


class PaperAgentService:
    def __init__(
        self,
        settings: AppSettings | None = None,
        *,
        vector_store: PaperVectorStore | None = None,
        model: BaseChatModel | None = None,
        checkpointer: BaseCheckpointSaver[Any] | None = None,
        memory_store: BaseStore | None = None,
        middleware: tuple[Any, ...] | None = None,
    ) -> None:
        self.settings = settings or load_settings()
        self.vector_store = vector_store or PaperVectorStore(
            self.settings.chroma_dir, create_embedding(self.settings)
        )
        self.model = model or create_chat_model(self.settings)
        self._checkpoint_connection: sqlite3.Connection | None = None
        if checkpointer is None:
            self.settings.checkpoint_db.parent.mkdir(parents=True, exist_ok=True)
            self._checkpoint_connection = sqlite3.connect(
                self.settings.checkpoint_db, check_same_thread=False
            )
            checkpointer = SqliteSaver(self._checkpoint_connection)
        self.checkpointer = checkpointer
        self.memory_store = memory_store or InMemoryStore()
        self.long_term_memory = LongTermMemory(self.memory_store, self.settings.memory_file)
        self.token_tracker = TokenUsageTracker()
        if middleware is None:
            middleware = (
                create_skill_prompt_middleware(self.settings.root_dir / "skills"),
                create_token_stats_middleware(self.token_tracker),
            )
        self.quality_agent = QualityAgent(self.model)
        self.tools = build_agent_tools(self.vector_store, self.settings, self.quality_agent)
        self.graph = create_agent(
            self.model,
            tools=self.tools,
            system_prompt=PAPER_AGENT_SYSTEM_PROMPT,
            middleware=middleware,
            context_schema=AgentContext,
            checkpointer=self.checkpointer,
            store=self.memory_store,
            name="paper_reading_agent",
        )

    def ask(
        self,
        question: str,
        *,
        thread_id: str,
        user_id: str,
        active_paper_id: str | None = None,
    ) -> AgentAnswer:
        if not question.strip():
            raise ValueError("问题不能为空。")
        context = AgentContext(user_id=user_id, session_id=thread_id, active_paper_id=active_paper_id)
        config = {"configurable": {"thread_id": thread_id}}
        try:
            result = self.graph.invoke(
                {"messages": [{"role": "user", "content": question.strip()}]},
                config=config,
                context=context,
            )
        except Exception as exc:
            raise AgentUnavailableError("模型调用失败，请检查模型服务配置后重试。") from exc
        messages = list(result.get("messages", []))
        sources, retrieval_was_empty = _sources_from_messages(messages)
        answer = _last_ai_text(messages)
        if retrieval_was_empty and not sources:
            answer = UNKNOWN_ANSWER
        if not answer:
            answer = UNKNOWN_ANSWER if retrieval_was_empty else "模型未返回可显示的回答。"
        self._record_interaction(user_id, thread_id, question, active_paper_id)
        return AgentAnswer(answer, sources, len(messages))

    def stream_ask(
        self,
        question: str,
        *,
        thread_id: str,
        user_id: str,
        active_paper_id: str | None = None,
    ) -> Iterator[AgentStreamEvent]:
        if not question.strip():
            raise ValueError("问题不能为空。")
        context = AgentContext(user_id=user_id, session_id=thread_id, active_paper_id=active_paper_id)
        config = {"configurable": {"thread_id": thread_id}}
        sources: tuple[Passage, ...] = ()
        retrieval_was_empty = False
        emitted_text = False
        try:
            events = self.graph.stream(
                {"messages": [{"role": "user", "content": question.strip()}]},
                config=config,
                context=context,
                stream_mode=["messages", "values"],
            )
            for mode, payload in events:
                if mode == "values":
                    messages = list(payload.get("messages", [])) if isinstance(payload, dict) else []
                    current_sources, current_empty = _sources_from_messages(messages)
                    if current_sources:
                        sources = current_sources
                    retrieval_was_empty = retrieval_was_empty or current_empty
                    continue
                if mode != "messages" or not isinstance(payload, tuple):
                    continue
                message = payload[0]
                if not isinstance(message, (AIMessage, AIMessageChunk)):
                    continue
                if getattr(message, "tool_calls", None) or getattr(message, "tool_call_chunks", None):
                    continue
                token = _message_content_text(message)
                if not token or (retrieval_was_empty and not sources):
                    continue
                emitted_text = True
                yield AgentStreamEvent("token", text=token)
        except Exception as exc:
            raise AgentUnavailableError("模型调用失败，请检查模型服务配置后重试。") from exc

        if retrieval_was_empty and not sources:
            yield AgentStreamEvent("replace", text=UNKNOWN_ANSWER)
        elif not emitted_text:
            yield AgentStreamEvent("replace", text="模型未返回可显示的回答。")
        if sources:
            yield AgentStreamEvent("sources", sources=sources)
        self._record_interaction(user_id, thread_id, question, active_paper_id)
        yield AgentStreamEvent("done", sources=sources)

    def token_usage(self, session_id: str) -> TokenUsage:
        return self.token_tracker.snapshot(session_id)

    def _record_interaction(
        self,
        user_id: str,
        thread_id: str,
        question: str,
        active_paper_id: str | None,
    ) -> None:
        self.long_term_memory.record_question(
            user_id,
            session_id=thread_id,
            question=question.strip(),
            paper_id=active_paper_id,
        )
        if not active_paper_id:
            return
        paper = next(
            (item for item in self.vector_store.list_papers() if item["paper_id"] == active_paper_id),
            None,
        )
        if paper:
            self.long_term_memory.remember_paper(user_id, active_paper_id, paper["title"])

    def close(self) -> None:
        if self._checkpoint_connection is not None:
            self._checkpoint_connection.close()
            self._checkpoint_connection = None


def _sources_from_messages(messages: list[BaseMessage]) -> tuple[tuple[Passage, ...], bool]:
    sources: list[Passage] = []
    saw_empty_retrieval = False
    seen_chunks: set[str] = set()
    for message in messages:
        if not isinstance(message, ToolMessage) or not isinstance(message.artifact, dict):
            continue
        if message.artifact.get("kind") != "retrieval":
            continue
        passage_records = message.artifact.get("passages", [])
        if not passage_records:
            saw_empty_retrieval = True
        for record in passage_records:
            passage = Passage(**record)
            if passage.chunk_id in seen_chunks:
                continue
            seen_chunks.add(passage.chunk_id)
            sources.append(passage)
    return tuple(sources), saw_empty_retrieval


def _last_ai_text(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if not isinstance(message, AIMessage) or message.tool_calls:
            continue
        if isinstance(message.content, str):
            return message.content.strip()
        if isinstance(message.content, list):
            parts = [
                str(part.get("text", ""))
                for part in message.content
                if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
            ]
            return "".join(parts).strip()
    return ""


def _message_content_text(message: AIMessage | AIMessageChunk) -> str:
    if isinstance(message.content, str):
        return message.content
    if isinstance(message.content, list):
        return "".join(
            str(part.get("text", ""))
            for part in message.content
            if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
        )
    return ""
