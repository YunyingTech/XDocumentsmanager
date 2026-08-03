"""Paragraph retrieval with explicit source metadata and no-answer semantics."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from core.store import PaperVectorStore


UNKNOWN_ANSWER = "不知道。当前已入库论文中没有检索到足够相关的段落。"


@dataclass(frozen=True, slots=True)
class Passage:
    text: str
    paper_id: str
    paper_title: str
    section: str
    page: int
    page_end: int
    para_idx: int
    source_label: str
    distance: float
    chunk_id: str
    placeholders: tuple[dict[str, Any], ...] = ()

    @property
    def citation(self) -> str:
        pages = str(self.page) if self.page == self.page_end else f"{self.page}-{self.page_end}"
        return f"{self.paper_title} · {self.section} · p.{pages} · paragraph {self.para_idx}"


def retrieve_paragraphs(
    store: PaperVectorStore,
    query: str,
    *,
    paper_id: str | None = None,
    k: int = 5,
    max_distance: float = 1.25,
) -> list[Passage]:
    if not query.strip():
        return []
    passages: list[Passage] = []
    for record in store.query(query, paper_id=paper_id, k=k):
        if record["distance"] > max_distance:
            continue
        metadata = record["metadata"]
        try:
            placeholders = tuple(json.loads(str(metadata.get("placeholders_json", "[]"))))
        except (TypeError, json.JSONDecodeError):
            placeholders = ()
        passages.append(
            Passage(
                text=str(record["document"]),
                paper_id=str(metadata["paper_id"]),
                paper_title=str(metadata["paper_title"]),
                section=str(metadata["section"]),
                page=int(metadata["page"]),
                page_end=int(metadata["page_end"]),
                para_idx=int(metadata["para_idx"]),
                source_label=str(metadata["source_label"]),
                distance=float(record["distance"]),
                chunk_id=str(metadata["chunk_id"]),
                placeholders=placeholders,
            )
        )
    return passages


def passages_as_context(passages: list[Passage]) -> str:
    return "\n\n".join(
        f"[S{index} | {passage.citation}]\n{passage.text}"
        for index, passage in enumerate(passages, start=1)
    )
