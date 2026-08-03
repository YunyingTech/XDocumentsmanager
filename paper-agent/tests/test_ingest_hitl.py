from __future__ import annotations

from pathlib import Path

import fitz
from langgraph.checkpoint.memory import InMemorySaver

from core.config import AppSettings
from core.store import HashEmbedding, PaperVectorStore
from tools.ingest import PaperIngestionWorkflow, paper_id_for


def _settings(tmp_path: Path) -> AppSettings:
    return AppSettings(
        root_dir=tmp_path,
        llm_base_url="http://localhost:1234/v1",
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
        memory_file=tmp_path / "memory.json",
        upload_dir=tmp_path / "uploads",
        max_upload_mb=5,
        retrieval_top_k=3,
        retrieval_max_distance=1.5,
        chunk_size=300,
        chunk_overlap=40,
    )


def _write_paper(path: Path) -> bytes:
    document = fitz.open()
    page = document.new_page()
    text = "1 Introduction\n" + ("Evidence-grounded reading. " * 15)
    text += "\n\n2 Methods\n" + ("Dense retrieval selects paragraphs. " * 15)
    page.insert_textbox(fitz.Rect(72, 72, 520, 760), text, fontsize=10)
    data = document.tobytes()
    document.close()
    path.write_bytes(data)
    return data


def test_hitl_interrupts_before_write_and_confirmed_resume_ingests(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    data = _write_paper(path)
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    workflow = PaperIngestionWorkflow(store, _settings(tmp_path), InMemorySaver())
    paper_id = paper_id_for(data, path.name)

    pending = workflow.start(
        path, paper_id=paper_id, title="Evidence Paper", thread_id="ingest-1"
    )

    assert pending.status == "awaiting_confirmation"
    assert pending.requires_confirmation is True
    assert {section["canonical"] for section in pending.sections} == {"introduction", "methods"}
    assert store.count_paper(paper_id) == 0

    corrected = [dict(section) for section in pending.sections]
    corrected[1]["title"] = "Retrieval Methods"
    completed = workflow.resume(
        thread_id="ingest-1", confirmed=True, sections=corrected
    )

    assert completed.status == "completed"
    assert completed.chunk_count > 0
    assert store.count_paper(paper_id) == completed.chunk_count
    assert any(section["title"] == "Retrieval Methods" for section in completed.sections)


def test_hitl_rejection_and_invalid_file_never_write(tmp_path: Path) -> None:
    path = tmp_path / "paper.pdf"
    data = _write_paper(path)
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    workflow = PaperIngestionWorkflow(store, _settings(tmp_path), InMemorySaver())
    paper_id = paper_id_for(data, path.name)
    workflow.start(path, paper_id=paper_id, title="Rejected", thread_id="ingest-reject")

    rejected = workflow.resume(thread_id="ingest-reject", confirmed=False)

    assert rejected.status == "rejected"
    assert rejected.chunk_count == 0
    assert store.count_paper(paper_id) == 0

    invalid = tmp_path / "notes.txt"
    invalid.write_text("not a pdf", encoding="utf-8")
    failed = workflow.start(
        invalid, paper_id="invalid", title="Invalid", thread_id="ingest-invalid"
    )
    assert failed.status == "failed"
    assert "PDF" in failed.message
