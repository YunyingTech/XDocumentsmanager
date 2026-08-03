"""Confirmed writes of processed paper chunks into Chroma."""

from __future__ import annotations

from collections.abc import Sequence

from core.store import PaperVectorStore
from tools.chunking import Chunk


class IngestApprovalRequired(PermissionError):
    """Raised when code attempts to write before explicit user confirmation."""


def ingest_paper(
    store: PaperVectorStore,
    paper_id: str,
    title: str,
    chunks: Sequence[Chunk],
    *,
    confirmed: bool,
) -> int:
    if not confirmed:
        raise IngestApprovalRequired("章节结构尚未确认，未写入向量库。")
    if not chunks:
        raise ValueError("论文没有可入库的文本分片。")
    return store.upsert_paper(paper_id, title, chunks)
