"""Confirmed writes and a LangGraph HITL ingestion workflow."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
from typing import Any, Literal, NotRequired, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from core.config import AppSettings
from core.pdf_loader import ImageRegion, PaperLoadError, load_pdf
from core.store import PaperVectorStore
from tools.chunking import Chunk, chunk_with_placeholders
from tools.structure import Section, build_section_tree, extract_paper_structure


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


class IngestionState(TypedDict):
    paper_id: str
    title: str
    file_path: str
    filename: str
    text: NotRequired[str]
    sections: NotRequired[list[dict[str, Any]]]
    image_regions: NotRequired[list[dict[str, Any]]]
    extractor: NotRequired[str]
    status: NotRequired[str]
    message: NotRequired[str]
    chunk_count: NotRequired[int]


@dataclass(frozen=True, slots=True)
class IngestionResult:
    status: str
    message: str
    paper_id: str
    title: str
    sections: tuple[dict[str, Any], ...] = ()
    structure_tree: tuple[dict[str, Any], ...] = ()
    chunk_count: int = 0
    requires_confirmation: bool = False


class PaperIngestionWorkflow:
    """Extract, pause for section approval, then write chunks to Chroma."""

    def __init__(
        self,
        store: PaperVectorStore,
        settings: AppSettings,
        checkpointer: BaseCheckpointSaver[Any],
    ) -> None:
        self.store = store
        self.settings = settings
        builder = StateGraph(IngestionState)
        builder.add_node("extract", self._extract)
        builder.add_node("review", self._review)
        builder.add_node("ingest", self._ingest)
        builder.add_edge(START, "extract")
        builder.add_edge("extract", "review")
        builder.add_edge("ingest", END)
        self.graph = builder.compile(checkpointer=checkpointer)

    def start(
        self,
        file_path: str | Path,
        *,
        paper_id: str,
        title: str,
        thread_id: str,
    ) -> IngestionResult:
        path = Path(file_path)
        initial: IngestionState = {
            "paper_id": _safe_paper_id(paper_id),
            "title": title.strip() or path.stem,
            "file_path": str(path),
            "filename": path.name,
            "status": "extracting",
        }
        try:
            result = self.graph.invoke(initial, config=_thread_config(thread_id))
        except PaperLoadError as exc:
            return IngestionResult("failed", str(exc), initial["paper_id"], initial["title"])
        except Exception as exc:
            return IngestionResult(
                "failed",
                "论文处理失败，请检查文件后重试。",
                initial["paper_id"],
                initial["title"],
            )
        return self._as_result(result)

    def resume(
        self,
        *,
        thread_id: str,
        confirmed: bool,
        sections: Sequence[dict[str, Any]] | None = None,
    ) -> IngestionResult:
        decision = {"confirmed": bool(confirmed), "sections": list(sections or [])}
        try:
            result = self.graph.invoke(
                Command(resume=decision), config=_thread_config(thread_id)
            )
        except ValueError as exc:
            state = self.graph.get_state(_thread_config(thread_id)).values
            return IngestionResult(
                "failed",
                str(exc),
                str(state.get("paper_id", "unknown")),
                str(state.get("title", "Untitled")),
            )
        except Exception:
            state = self.graph.get_state(_thread_config(thread_id)).values
            return IngestionResult(
                "failed",
                "确认入库失败，请稍后重试。",
                str(state.get("paper_id", "unknown")),
                str(state.get("title", "Untitled")),
            )
        return self._as_result(result)

    def pending(self, thread_id: str) -> IngestionResult | None:
        snapshot = self.graph.get_state(_thread_config(thread_id))
        if not snapshot.values:
            return None
        return self._as_result(dict(snapshot.values))

    def _extract(self, state: IngestionState) -> dict[str, Any]:
        document = load_pdf(
            state["file_path"],
            filename=state["filename"],
            max_size_mb=self.settings.max_upload_mb,
        )
        sections = extract_paper_structure(document.text)
        images = [
            {
                "image_id": image.image_id,
                "page": image.page,
                "bbox": list(image.bbox),
            }
            for page in document.pages
            for image in page.images
        ]
        return {
            "text": document.text,
            "sections": [section.to_dict() for section in sections],
            "image_regions": images,
            "extractor": document.extractor,
            "status": "awaiting_confirmation",
            "message": "请核对章节结构，确认后才会写入向量库。",
        }

    def _review(
        self, state: IngestionState
    ) -> Command[Literal["ingest", "__end__"]]:
        payload = {
            "kind": "section_review",
            "paper_id": state["paper_id"],
            "title": state["title"],
            "sections": state.get("sections", []),
            "structure_tree": _tree_from_records(state.get("sections", [])),
            "message": "章节识别已完成。确认或修正后才能入库。",
        }
        decision = interrupt(payload)
        if not isinstance(decision, dict) or not decision.get("confirmed"):
            return Command(
                goto=END,
                update={"status": "rejected", "message": "用户取消入库，未写入任何分片。"},
            )
        submitted = decision.get("sections") or state.get("sections", [])
        validated = _validate_section_records(submitted, len(state.get("text", "")))
        return Command(
            goto="ingest",
            update={
                "sections": validated,
                "status": "approved",
                "message": "章节结构已确认，正在入库。",
            },
        )

    def _ingest(self, state: IngestionState) -> dict[str, Any]:
        sections = [_section_from_record(record) for record in state.get("sections", [])]
        images = [
            ImageRegion(
                image_id=str(record["image_id"]),
                page=int(record["page"]),
                bbox=tuple(float(value) for value in record["bbox"]),  # type: ignore[arg-type]
            )
            for record in state.get("image_regions", [])
        ]
        chunks = chunk_with_placeholders(
            sections,
            state.get("text", ""),
            image_regions=images,
            chunk_size=self.settings.chunk_size,
            overlap=self.settings.chunk_overlap,
        )
        count = ingest_paper(
            self.store,
            state["paper_id"],
            state["title"],
            chunks,
            confirmed=True,
        )
        return {
            "status": "completed",
            "message": f"已确认并写入 {count} 个分片。",
            "chunk_count": count,
        }

    @staticmethod
    def _as_result(result: dict[str, Any]) -> IngestionResult:
        interrupts = result.get("__interrupt__") or ()
        if interrupts:
            payload = interrupts[0].value
            sections = tuple(payload.get("sections", []))
            return IngestionResult(
                status="awaiting_confirmation",
                message=str(payload.get("message", "请确认章节结构。")),
                paper_id=str(payload.get("paper_id", result.get("paper_id", "unknown"))),
                title=str(payload.get("title", result.get("title", "Untitled"))),
                sections=sections,
                structure_tree=tuple(payload.get("structure_tree", [])),
                requires_confirmation=True,
            )
        records = tuple(result.get("sections", []))
        return IngestionResult(
            status=str(result.get("status", "failed")),
            message=str(result.get("message", "论文处理状态未知。")),
            paper_id=str(result.get("paper_id", "unknown")),
            title=str(result.get("title", "Untitled")),
            sections=records,
            structure_tree=tuple(_tree_from_records(records)),
            chunk_count=int(result.get("chunk_count", 0)),
        )


def paper_id_for(data: bytes, filename: str) -> str:
    digest = hashlib.sha256(data).hexdigest()[:16]
    stem = _safe_paper_id(Path(filename).stem)[:32]
    return f"{stem}-{digest}"


def _safe_paper_id(value: str) -> str:
    result = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-.").lower()
    return result or "paper"


def _thread_config(thread_id: str) -> dict[str, dict[str, str]]:
    if not thread_id.strip():
        raise ValueError("thread_id 不能为空。")
    return {"configurable": {"thread_id": thread_id}}


def _validate_section_records(
    records: Sequence[dict[str, Any]], text_length: int
) -> list[dict[str, Any]]:
    validated: list[dict[str, Any]] = []
    previous_start = -1
    for index, record in enumerate(records):
        title = str(record.get("title", "")).strip()
        if not title:
            raise ValueError(f"第 {index + 1} 个章节标题不能为空。")
        level = int(record.get("level", 1))
        page = int(record.get("page", 1))
        char_start = int(record.get("char_start", 0))
        if not 1 <= level <= 5:
            raise ValueError(f"章节“{title}”的层级必须在 1 到 5 之间。")
        if page < 1:
            raise ValueError(f"章节“{title}”的页码必须大于 0。")
        if char_start < 0 or char_start >= max(1, text_length):
            raise ValueError(f"章节“{title}”的字符位置超出论文范围。")
        if char_start <= previous_start:
            raise ValueError("章节字符位置必须严格递增。")
        previous_start = char_start
        canonical = str(record.get("canonical", "other")).strip() or "other"
        validated.append(
            {
                "title": title,
                "level": level,
                "char_start": char_start,
                "page": page,
                "canonical": canonical,
                "number": record.get("number"),
            }
        )
    return validated


def _section_from_record(record: dict[str, Any]) -> Section:
    return Section(
        title=str(record["title"]),
        level=int(record["level"]),
        char_start=int(record["char_start"]),
        page=int(record["page"]),
        canonical=str(record.get("canonical", "other")),
        number=str(record["number"]) if record.get("number") is not None else None,
    )


def _tree_from_records(records: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return build_section_tree(_section_from_record(record) for record in records)
