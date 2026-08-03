from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from pydantic import Field, PrivateAttr

from agent.graph import PaperAgentService
from core.config import AppSettings
from core.store import HashEmbedding, PaperVectorStore
from tools.chunking import chunk_with_placeholders
from tools.ingest import ingest_paper
from tools.retrieval import UNKNOWN_ANSWER
from tools.structure import extract_paper_structure


class ScriptedChatModel(BaseChatModel):
    responses: list[AIMessage]
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    _cursor: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "scripted-test-model"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.calls.append(list(messages))
        response = self.responses[self._cursor]
        self._cursor += 1
        return ChatResult(generations=[ChatGeneration(message=response)])


class StreamingChatModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "streaming-test-model"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "StreamingChatModel":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="streamed answer"))])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ):
        yield ChatGenerationChunk(message=AIMessageChunk(content="streamed "))
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="answer",
                usage_metadata={"input_tokens": 6, "output_tokens": 2, "total_tokens": 8},
            )
        )


def _settings(tmp_path: Path) -> AppSettings:
    return AppSettings(
        root_dir=tmp_path,
        llm_base_url="http://localhost:1234/v1",
        llm_api_key="test",
        llm_model="test-model",
        llm_temperature=0.0,
        llm_timeout_seconds=5.0,
        embed_backend="hash",
        embed_model="hash",
        embed_base_url=None,
        embed_api_key=None,
        chroma_dir=tmp_path / "chroma",
        checkpoint_db=tmp_path / "checkpoints.sqlite3",
        memory_file=tmp_path / "memories.json",
        upload_dir=tmp_path / "uploads",
        max_upload_mb=10,
        retrieval_top_k=3,
        retrieval_max_distance=1.5,
        chunk_size=300,
        chunk_overlap=40,
    )


def _indexed_store(tmp_path: Path) -> PaperVectorStore:
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    text = """1 Introduction
Retrieval augmented generation grounds answers in evidence.

2 Methods
The retriever selects passages using dense vector similarity.
"""
    chunks = chunk_with_placeholders(
        extract_paper_structure(text), text, chunk_size=300, overlap=40
    )
    ingest_paper(store, "rag", "RAG Paper", chunks, confirmed=True)
    return store


def test_main_agent_calls_rag_tool_and_returns_source_artifacts(tmp_path: Path) -> None:
    model = ScriptedChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "retrieve_paper_passages",
                        "args": {"query": "dense vector retriever", "paper_id": "rag", "k": 2},
                        "id": "call-1",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="The retriever uses dense vector similarity. [S1]"),
        ]
    )
    service = PaperAgentService(
        _settings(tmp_path),
        vector_store=_indexed_store(tmp_path),
        model=model,
        checkpointer=InMemorySaver(),
        memory_store=InMemoryStore(),
    )

    answer = service.ask(
        "What retrieval method does this paper use?",
        thread_id="thread-a",
        user_id="user-a",
        active_paper_id="rag",
    )

    assert "[S1]" in answer.text
    assert answer.sources and answer.sources[0].paper_id == "rag"
    assert "Methods" in {source.section for source in answer.sources}


def test_checkpointer_keeps_turns_isolated_by_thread(tmp_path: Path) -> None:
    model = ScriptedChatModel(
        responses=[
            AIMessage(content="First answer."),
            AIMessage(content="Follow-up answer."),
            AIMessage(content="Other session."),
        ]
    )
    service = PaperAgentService(
        _settings(tmp_path),
        vector_store=_indexed_store(tmp_path),
        model=model,
        checkpointer=InMemorySaver(),
        memory_store=InMemoryStore(),
    )

    service.ask("Describe this paper.", thread_id="same", user_id="u", active_paper_id="rag")
    service.ask("What about its method?", thread_id="same", user_id="u", active_paper_id="rag")
    service.ask("New conversation.", thread_id="other", user_id="u", active_paper_id="rag")

    second_call_text = " ".join(str(message.content) for message in model.calls[1])
    third_call_text = " ".join(
        str(message.content)
        for message in model.calls[2]
        if not isinstance(message, SystemMessage)
    )
    assert "Describe this paper." in second_call_text
    assert "First answer." in second_call_text
    assert "Describe this paper." not in third_call_text


def test_empty_retrieval_is_forced_to_unknown(tmp_path: Path) -> None:
    model = ScriptedChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "retrieve_paper_passages",
                        "args": {"query": "missing topic", "paper_id": "does-not-exist"},
                        "id": "call-empty",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="A hallucinated answer."),
        ]
    )
    service = PaperAgentService(
        _settings(tmp_path),
        vector_store=_indexed_store(tmp_path),
        model=model,
        checkpointer=InMemorySaver(),
        memory_store=InMemoryStore(),
    )

    answer = service.ask(
        "What is missing?",
        thread_id="empty",
        user_id="u",
        active_paper_id="does-not-exist",
    )

    assert answer.text == UNKNOWN_ANSWER
    assert answer.sources == ()


def test_stream_ask_emits_model_tokens_and_done_event(tmp_path: Path) -> None:
    service = PaperAgentService(
        _settings(tmp_path),
        vector_store=_indexed_store(tmp_path),
        model=StreamingChatModel(),
        checkpointer=InMemorySaver(),
        memory_store=InMemoryStore(),
    )

    events = list(
        service.stream_ask(
            "Give a short greeting.",
            thread_id="stream",
            user_id="u",
            active_paper_id=None,
        )
    )

    assert "".join(event.text for event in events if event.kind == "token") == "streamed answer"
    assert events[-1].kind == "done"
    assert service.token_usage("stream").total_tokens == 8
