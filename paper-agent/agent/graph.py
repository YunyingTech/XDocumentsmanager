"""Main LangChain agent with RAG tools, Checkpointer, and Store."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from langchain.agents import create_agent
from langchain.tools import ToolRuntime, tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore

from agent.prompts import PAPER_AGENT_SYSTEM_PROMPT
from core.config import AppSettings, create_chat_model, create_embedding, load_settings
from core.store import PaperVectorStore
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


def build_agent_tools(
    vector_store: PaperVectorStore,
    settings: AppSettings,
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

    return [retrieve_tool, list_papers_tool]


class PaperAgentService:
    def __init__(
        self,
        settings: AppSettings | None = None,
        *,
        vector_store: PaperVectorStore | None = None,
        model: BaseChatModel | None = None,
        checkpointer: BaseCheckpointSaver[Any] | None = None,
        memory_store: BaseStore | None = None,
        middleware: tuple[Any, ...] = (),
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
        self.tools = build_agent_tools(self.vector_store, self.settings)
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
        return AgentAnswer(answer, sources, len(messages))

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
