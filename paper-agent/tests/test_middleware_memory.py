from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from pydantic import Field, PrivateAttr

from agent.graph import PaperAgentService
from core.config import AppSettings
from core.store import HashEmbedding, LongTermMemory, PaperVectorStore


class UsageModel(BaseChatModel):
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    _counter: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "usage-model"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "UsageModel":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.calls.append(list(messages))
        self._counter += 1
        message = AIMessage(
            content=f"answer-{self._counter}",
            usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


def _settings(tmp_path: Path) -> AppSettings:
    skills = tmp_path / "skills"
    skills.mkdir()
    (skills / "paper_overview.md").write_text("SKILL_SENTINEL: cite every source", encoding="utf-8")
    return AppSettings(
        root_dir=tmp_path,
        llm_base_url="http://localhost/v1",
        llm_api_key="test",
        llm_model="test",
        llm_temperature=0.0,
        llm_timeout_seconds=5.0,
        embed_backend="hash",
        embed_model="hash",
        embed_base_url=None,
        embed_api_key=None,
        chroma_dir=tmp_path / "chroma",
        checkpoint_db=tmp_path / "checkpoint.sqlite3",
        memory_file=tmp_path / "memories.json",
        upload_dir=tmp_path / "uploads",
        max_upload_mb=5,
        retrieval_top_k=3,
        retrieval_max_distance=1.5,
        chunk_size=300,
        chunk_overlap=40,
    )


def test_token_middleware_isolates_sessions_and_injects_runtime_skill(tmp_path: Path) -> None:
    model = UsageModel()
    service = PaperAgentService(
        _settings(tmp_path),
        vector_store=PaperVectorStore(tmp_path / "chroma", HashEmbedding()),
        model=model,
        checkpointer=InMemorySaver(),
        memory_store=InMemoryStore(),
    )

    service.ask("hello", thread_id="one", user_id="alice")
    service.ask("again", thread_id="one", user_id="alice")
    service.ask("separate", thread_id="two", user_id="alice")

    one = service.token_usage("one")
    two = service.token_usage("two")
    assert (one.calls, one.prompt_tokens, one.completion_tokens) == (2, 20, 8)
    assert (two.calls, two.total_tokens) == (1, 14)
    first_prompt = "\n".join(str(message.content) for message in model.calls[0])
    assert "SKILL_SENTINEL" in first_prompt


def test_long_term_memory_survives_new_store_and_sessions(tmp_path: Path) -> None:
    path = tmp_path / "memories.json"
    first = LongTermMemory(InMemoryStore(), path)
    first.remember_paper("Alice", "paper-1", "First Paper")
    first.record_question(
        "Alice", session_id="session-a", question="What is the method?", paper_id="paper-1"
    )
    first.set_preference("Alice", "answer_style", "concise")

    second_store = InMemoryStore()
    second = LongTermMemory(second_store, path)
    profile = second.profile("alice")

    assert profile["read_papers"]["paper-1"]["title"] == "First Paper"
    assert profile["history"][0]["session_id"] == "session-a"
    assert profile["preferences"]["answer_style"] == "concise"
    mirrored = second_store.get(("users", "alice"), "profile")
    assert mirrored is not None and mirrored.value == profile
