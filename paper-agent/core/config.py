"""Environment-only configuration for the self-contained paper agent."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from core.store import (
    EmbeddingProvider,
    HashEmbedding,
    OpenAIEmbedding,
    SentenceTransformerEmbedding,
)


@dataclass(frozen=True, slots=True)
class AppSettings:
    root_dir: Path
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    llm_temperature: float
    llm_timeout_seconds: float
    embed_backend: str
    embed_model: str
    embed_base_url: str | None
    embed_api_key: str | None
    chroma_dir: Path
    checkpoint_db: Path
    memory_file: Path
    upload_dir: Path
    max_upload_mb: int
    retrieval_top_k: int
    retrieval_max_distance: float
    chunk_size: int
    chunk_overlap: int


def load_settings(env_file: str | Path | None = None) -> AppSettings:
    root = Path(__file__).resolve().parents[1]
    dotenv_path = Path(env_file) if env_file else root / ".env"
    load_dotenv(dotenv_path=dotenv_path, override=False)

    settings = AppSettings(
        root_dir=root,
        llm_base_url=os.getenv("LLM_BASE_URL", "http://127.0.0.1:1234/v1").strip(),
        llm_api_key=os.getenv("LLM_API_KEY", "lm-studio").strip(),
        llm_model=os.getenv("LLM_MODEL", "qwen3-8b").strip(),
        llm_temperature=_float_env("LLM_TEMPERATURE", 0.1, minimum=0.0),
        llm_timeout_seconds=_float_env("LLM_TIMEOUT_SECONDS", 90.0, minimum=1.0),
        embed_backend=os.getenv("EMBED_BACKEND", "local").strip().casefold(),
        embed_model=os.getenv("EMBED_MODEL", "BAAI/bge-small-zh-v1.5").strip(),
        embed_base_url=_optional_env("EMBED_BASE_URL"),
        embed_api_key=_optional_env("EMBED_API_KEY"),
        chroma_dir=_path_env(root, "CHROMA_DIR", "chroma_db"),
        checkpoint_db=_path_env(root, "CHECKPOINT_DB", "runtime/checkpoints.sqlite3"),
        memory_file=_path_env(root, "MEMORY_FILE", "runtime/memories.json"),
        upload_dir=_path_env(root, "UPLOAD_DIR", "runtime/uploads"),
        max_upload_mb=_int_env("MAX_UPLOAD_MB", 50, minimum=1),
        retrieval_top_k=_int_env("RETRIEVAL_TOP_K", 5, minimum=1),
        retrieval_max_distance=_float_env("RETRIEVAL_MAX_DISTANCE", 1.25, minimum=0.0),
        chunk_size=_int_env("CHUNK_SIZE", 1200, minimum=200),
        chunk_overlap=_int_env("CHUNK_OVERLAP", 180, minimum=0),
    )
    if not settings.llm_model:
        raise ValueError("LLM_MODEL 不能为空。")
    if settings.chunk_overlap >= settings.chunk_size:
        raise ValueError("CHUNK_OVERLAP 必须小于 CHUNK_SIZE。")
    if settings.embed_backend not in {"local", "api", "hash"}:
        raise ValueError("EMBED_BACKEND 必须是 local、api 或 hash。")
    if settings.embed_backend == "api" and not settings.embed_api_key:
        raise ValueError("使用 API embedding 时必须配置 EMBED_API_KEY。")
    return settings


def create_chat_model(settings: AppSettings) -> BaseChatModel:
    return ChatOpenAI(
        model=settings.llm_model,
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key or "not-required",
        temperature=settings.llm_temperature,
        timeout=settings.llm_timeout_seconds,
        max_retries=2,
        streaming=True,
        stream_usage=True,
    )


def create_embedding(settings: AppSettings) -> EmbeddingProvider:
    if settings.embed_backend == "local":
        return SentenceTransformerEmbedding(settings.embed_model)
    if settings.embed_backend == "api":
        return OpenAIEmbedding(
            settings.embed_model,
            api_key=settings.embed_api_key or "",
            base_url=settings.embed_base_url,
        )
    return HashEmbedding()


def _path_env(root: Path, key: str, default: str) -> Path:
    value = Path(os.getenv(key, default).strip())
    return value if value.is_absolute() else (root / value).resolve()


def _optional_env(key: str) -> str | None:
    value = os.getenv(key, "").strip()
    return value or None


def _int_env(key: str, default: int, *, minimum: int) -> int:
    try:
        value = int(os.getenv(key, str(default)))
    except ValueError as exc:
        raise ValueError(f"{key} 必须是整数。") from exc
    if value < minimum:
        raise ValueError(f"{key} 不能小于 {minimum}。")
    return value


def _float_env(key: str, default: float, *, minimum: float) -> float:
    try:
        value = float(os.getenv(key, str(default)))
    except ValueError as exc:
        raise ValueError(f"{key} 必须是数字。") from exc
    if value < minimum:
        raise ValueError(f"{key} 不能小于 {minimum}。")
    return value
