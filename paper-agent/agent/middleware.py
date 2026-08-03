"""LangChain middleware for usage telemetry and skill-aware prompts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
from threading import RLock
from time import perf_counter
from typing import Any

from langchain.agents.middleware import ModelRequest, ModelResponse, dynamic_prompt, wrap_model_call
from langchain_core.messages import AIMessage, BaseMessage

from core.store import memory_user_id


@dataclass(frozen=True, slots=True)
class TokenUsage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_seconds: float = 0.0
    estimated_calls: int = 0

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


class TokenUsageTracker:
    def __init__(self) -> None:
        self._usage: dict[str, TokenUsage] = {}
        self._lock = RLock()

    def record(
        self,
        session_id: str,
        *,
        prompt_tokens: int,
        completion_tokens: int,
        latency_seconds: float,
        estimated: bool,
    ) -> None:
        with self._lock:
            current = self._usage.get(session_id, TokenUsage())
            self._usage[session_id] = TokenUsage(
                calls=current.calls + 1,
                prompt_tokens=current.prompt_tokens + max(0, prompt_tokens),
                completion_tokens=current.completion_tokens + max(0, completion_tokens),
                total_tokens=current.total_tokens + max(0, prompt_tokens) + max(0, completion_tokens),
                latency_seconds=round(current.latency_seconds + max(0.0, latency_seconds), 6),
                estimated_calls=current.estimated_calls + int(estimated),
            )

    def snapshot(self, session_id: str) -> TokenUsage:
        with self._lock:
            return self._usage.get(session_id, TokenUsage())

    def reset(self, session_id: str) -> None:
        with self._lock:
            self._usage.pop(session_id, None)


def create_token_stats_middleware(tracker: TokenUsageTracker):
    @wrap_model_call(name="SessionTokenStatsMiddleware")
    def token_stats(request: ModelRequest, handler):
        started = perf_counter()
        response = handler(request)
        latency = perf_counter() - started
        prompt_tokens, completion_tokens, estimated = _usage_from_response(request, response)
        tracker.record(
            _session_id(request),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_seconds=latency,
            estimated=estimated,
        )
        return response

    return token_stats


def create_skill_prompt_middleware(skills_directory: str | Path):
    skills_path = Path(skills_directory)

    @dynamic_prompt
    def skill_prompt(request: ModelRequest) -> str:
        base_prompt = request.system_prompt or ""
        skill_text = _load_skills(skills_path)
        profile_text = _profile_prompt(request)
        additions = [part for part in (skill_text, profile_text) if part]
        if not additions:
            return base_prompt
        return base_prompt.rstrip() + "\n\n" + "\n\n".join(additions)

    return skill_prompt


def _usage_from_response(
    request: ModelRequest, response: ModelResponse | AIMessage
) -> tuple[int, int, bool]:
    messages = response.result if isinstance(response, ModelResponse) else [response]
    prompt = 0
    completion = 0
    found_usage = False
    for message in messages:
        if not isinstance(message, AIMessage) or not message.usage_metadata:
            continue
        usage = message.usage_metadata
        prompt += int(usage.get("input_tokens", 0))
        completion += int(usage.get("output_tokens", 0))
        found_usage = True
    if found_usage:
        return prompt, completion, False
    prompt_text = "\n".join(_message_text(message) for message in request.messages)
    completion_text = "\n".join(_message_text(message) for message in messages)
    return _estimate_tokens(prompt_text), _estimate_tokens(completion_text), True


def _session_id(request: ModelRequest) -> str:
    runtime = request.runtime
    context = runtime.context if runtime is not None else None
    if isinstance(context, dict):
        return str(context.get("session_id", "default"))
    return str(getattr(context, "session_id", "default"))


def _profile_prompt(request: ModelRequest) -> str:
    runtime = request.runtime
    context = runtime.context if runtime is not None else None
    store = runtime.store if runtime is not None else None
    if store is None:
        return ""
    user_id = context.get("user_id") if isinstance(context, dict) else getattr(context, "user_id", None)
    if not user_id:
        return ""
    item = store.get(("users", memory_user_id(str(user_id))), "profile")
    if item is None:
        return ""
    compact = json.dumps(item.value, ensure_ascii=False, separators=(",", ":"))[:5000]
    return "## 用户长期阅读记忆\n仅用于理解偏好和历史论文，不得把记忆当作论文事实证据。\n" + compact


def _load_skills(skills_directory: Path) -> str:
    if not skills_directory.exists():
        return ""
    sections: list[str] = []
    for path in sorted(skills_directory.glob("*.md")):
        try:
            content = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if content:
            sections.append(f"## Runtime Skill: {path.stem}\n{content}")
    return "\n\n".join(sections)[:16000]


def _message_text(message: BaseMessage) -> str:
    if isinstance(message.content, str):
        return message.content
    return json.dumps(message.content, ensure_ascii=False, default=str)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = sum("\u3400" <= char <= "\u9fff" for char in text)
    non_cjk = max(0, len(text) - cjk)
    return max(1, cjk + (non_cjk + 3) // 4)
