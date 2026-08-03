from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr

from agent.subagents.quality_agent import QualityAgent, deterministic_quality_scores
from core.store import HashEmbedding, PaperVectorStore
from tools.chunking import chunk_with_placeholders
from tools.compare import compare_papers
from tools.ingest import ingest_paper
from tools.references import extract_references
from tools.structure import extract_paper_structure


class OneResponseModel(BaseChatModel):
    response: AIMessage
    _used: bool = PrivateAttr(default=False)

    @property
    def _llm_type(self) -> str:
        return "one-response"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "OneResponseModel":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        if self._used:
            raise RuntimeError("unexpected second model call")
        self._used = True
        return ChatResult(generations=[ChatGeneration(message=self.response)])


def _ingest(store: PaperVectorStore, paper_id: str, title: str, text: str) -> None:
    chunks = chunk_with_placeholders(
        extract_paper_structure(text), text, chunk_size=300, overlap=40
    )
    ingest_paper(store, paper_id, title, chunks, confirmed=True)


def test_quality_scores_are_deterministic_and_reasons_come_from_subagent(tmp_path: Path) -> None:
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    text = """Abstract
We propose a novel retrieval model.
1 Introduction
The new method improves evidence grounding.
2 Methods
Our method describes the architecture, training hyperparameters, baseline and ablation study.
3 Experiments
We evaluate on the SQuAD dataset and report accuracy, F1, confidence intervals and results.
4 Conclusion
The model improves retrieval.
"""
    _ingest(store, "quality", "Quality Paper", text)
    scores, _ = deterministic_quality_scores(store, "quality")
    model = OneResponseModel(
        response=AIMessage(
            content='{"reasons":{"methodology":"方法与消融证据充分 [Q1]",'
            '"data_support":"包含数据集和指标 [Q2]","innovation":"明确提出新模型 [Q1]",'
            '"clarity":"结构完整 [Q1]"},"summary":"证据较完整。"}'
        )
    )

    assessment = QualityAgent(model).assess(store, "quality", thread_id="t")

    assert assessment.scores == scores
    assert all(1 <= score <= 5 for score in scores.values())
    assert assessment.overall == round(sum(scores.values()) / 4, 2)
    assert "[Q1]" in assessment.reasons["methodology"]


def test_reference_parser_reports_mixed_styles_and_missing_fields() -> None:
    text = """1 Introduction
Body.
References
[1] A. Author and B. Writer. 2020. Reliable Retrieval. Journal of AI.
(2) C. Researcher. Missing Year Title. Conference Name
4. D. Scientist. 2022. Another Study.
"""

    report = extract_references(text)

    assert len(report.references) == 3
    codes = {issue.code for issue in report.format_issues}
    assert "mixed_markers" in codes
    assert "nonsequential_numbers" in codes
    assert "missing_year" in codes
    assert "missing_venue" in codes


def test_compare_papers_builds_markdown_table_for_two_or_three_papers(tmp_path: Path) -> None:
    store = PaperVectorStore(tmp_path / "chroma", HashEmbedding())
    _ingest(
        store,
        "rag-a",
        "Dense RAG",
        "1 Introduction\nRAG.\n2 Methods\nWe propose a dense retriever model. "
        "3 Experiments\nWe evaluate on MS MARCO dataset with MRR and Recall@10.",
    )
    _ingest(
        store,
        "rag-b",
        "Graph RAG",
        "1 Introduction\nGraph RAG.\n2 Methods\nWe use a graph retrieval architecture. "
        "3 Experiments\nThe HotpotQA benchmark uses F1 and exact match.",
    )

    table = compare_papers(store, ["rag-a", "rag-b"])

    assert "| 论文 | 方法 | 数据集 / 基准 | 指标 |" in table
    assert "Dense RAG" in table and "Graph RAG" in table
    assert "MS MARCO" in table and "HotpotQA" in table
    assert "MRR" in table and "F1" in table
