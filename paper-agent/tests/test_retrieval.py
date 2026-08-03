from pathlib import Path

import pytest

from core.store import HashEmbedding, PaperVectorStore
from tools.chunking import chunk_with_placeholders
from tools.ingest import IngestApprovalRequired, ingest_paper
from tools.retrieval import passages_as_context, retrieve_paragraphs
from tools.structure import extract_paper_structure


def _chunks(text: str):
    return chunk_with_placeholders(
        extract_paper_structure(text), text, chunk_size=300, overlap=40
    )


def test_ingest_requires_confirmation_and_retrieval_has_sources(tmp_path: Path) -> None:
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    rag_text = """1 Introduction
Retrieval augmented generation grounds answers in external evidence.

2 Methods
The retriever selects passages with dense vector similarity.
"""
    graph_text = """1 Introduction
Graph neural networks aggregate messages from neighboring nodes.

2 Methods
The model applies two graph convolution layers.
"""

    with pytest.raises(IngestApprovalRequired):
        ingest_paper(store, "rag", "RAG Paper", _chunks(rag_text), confirmed=False)
    assert ingest_paper(store, "rag", "RAG Paper", _chunks(rag_text), confirmed=True) > 0
    ingest_paper(store, "gnn", "Graph Paper", _chunks(graph_text), confirmed=True)

    results = retrieve_paragraphs(
        store,
        "dense retriever vector passages",
        paper_id="rag",
        k=3,
        max_distance=1.5,
    )

    assert results
    assert all(result.paper_id == "rag" for result in results)
    assert "Methods" in results[0].section
    assert "p.1" in results[0].citation
    assert "[S1 | RAG Paper" in passages_as_context(results)
    assert store.list_papers() == [
        {"paper_id": "gnn", "title": "Graph Paper"},
        {"paper_id": "rag", "title": "RAG Paper"},
    ]


def test_retrieval_returns_empty_for_blank_or_filtered_queries(tmp_path: Path) -> None:
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    text = "1 Introduction\nA paper about language models and evidence."
    ingest_paper(store, "paper", "Paper", _chunks(text), confirmed=True)

    assert retrieve_paragraphs(store, "") == []
    assert retrieve_paragraphs(store, "completely unrelated astronomy", max_distance=0.0) == []
