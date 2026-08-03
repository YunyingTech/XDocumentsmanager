"""Independent quality assessment agent with deterministic score aggregation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import re
from typing import Any

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver

from core.store import PaperVectorStore


QUALITY_DIMENSIONS = ("methodology", "data_support", "innovation", "clarity")

QUALITY_SYSTEM_PROMPT = """你是独立的论文质量评估子 Agent。
输入中已经由确定性代码给出四项分数，禁止修改分数。你只负责根据给定论文片段解释每项分数，并引用 [Q1] 等证据编号。
只返回 JSON：{"reasons":{"methodology":"...","data_support":"...","innovation":"...","clarity":"..."},"summary":"..."}。
证据不足时明确写“证据不足”，不得补造论文内容。
"""

_SIGNAL_GROUPS: dict[str, tuple[tuple[str, ...], ...]] = {
    "methodology": (
        ("method", "approach", "algorithm", "architecture", "方法", "算法", "架构"),
        ("baseline", "ablation", "control", "基线", "消融", "对照"),
        ("implementation", "hyperparameter", "training", "实现", "超参数", "训练"),
        ("limitation", "assumption", "局限", "假设"),
    ),
    "data_support": (
        ("dataset", "corpus", "sample", "数据集", "语料", "样本"),
        ("result", "table", "experiment", "结果", "实验", "表"),
        ("accuracy", "f1", "recall", "bleu", "rouge", "准确率", "召回率"),
        ("significant", "confidence", "variance", "显著", "置信", "方差"),
    ),
    "innovation": (
        ("we propose", "we introduce", "novel", "首次", "提出", "创新"),
        ("outperform", "state-of-the-art", "improve", "优于", "提升"),
        ("new", "original", "新的", "原创"),
    ),
}


@dataclass(frozen=True, slots=True)
class QualityAssessment:
    paper_id: str
    title: str
    scores: dict[str, int]
    overall: float
    reasons: dict[str, str]
    summary: str
    evidence: tuple[dict[str, Any], ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def deterministic_quality_scores(
    store: PaperVectorStore, paper_id: str
) -> tuple[dict[str, int], tuple[dict[str, Any], ...]]:
    records = store.records_for_paper(paper_id)
    if not records:
        raise ValueError(f"论文 {paper_id} 尚未入库。")
    text = "\n".join(str(record["document"]) for record in records).casefold()
    evidence = tuple(
        {
            "text": str(record["document"])[:600],
            "section": str(record["metadata"].get("section", "Unknown")),
            "page": int(record["metadata"].get("page", 1)),
            "para_idx": int(record["metadata"].get("para_idx", 1)),
        }
        for record in records[:10]
    )
    scores: dict[str, int] = {}
    for dimension, groups in _SIGNAL_GROUPS.items():
        matched_groups = sum(
            any(signal.casefold() in text for signal in group) for group in groups
        )
        scores[dimension] = min(5, 1 + matched_groups)

    section_kinds = {
        str(record["metadata"].get("section_canonical", "other")) for record in records
    }
    clarity_signals = sum(
        canonical in section_kinds
        for canonical in ("abstract", "introduction", "methods", "experiments", "conclusion")
    )
    readable_chunks = sum(80 <= len(str(record["document"])) <= 1800 for record in records)
    clarity = 1 + min(3, clarity_signals // 2) + int(readable_chunks >= max(1, len(records) // 2))
    scores["clarity"] = min(5, clarity)
    return scores, evidence


class QualityAgent:
    def __init__(
        self,
        model: BaseChatModel,
        *,
        checkpointer: BaseCheckpointSaver[Any] | None = None,
    ) -> None:
        self.graph = create_agent(
            model,
            tools=[],
            system_prompt=QUALITY_SYSTEM_PROMPT,
            checkpointer=checkpointer or InMemorySaver(),
            name="paper_quality_agent",
        )

    def assess(
        self,
        store: PaperVectorStore,
        paper_id: str,
        *,
        thread_id: str,
    ) -> QualityAssessment:
        records = store.records_for_paper(paper_id)
        if not records:
            raise ValueError(f"论文 {paper_id} 尚未入库。")
        title = str(records[0]["metadata"].get("paper_title", paper_id))
        scores, evidence = deterministic_quality_scores(store, paper_id)
        evidence_text = "\n\n".join(
            f"[Q{index} | {item['section']} | p.{item['page']} | paragraph {item['para_idx']}]\n{item['text']}"
            for index, item in enumerate(evidence, start=1)
        )
        prompt = (
            f"论文：{title}\n固定分数（不得修改）：{json.dumps(scores, ensure_ascii=False)}\n\n"
            f"论文证据：\n{evidence_text}"
        )
        result = self.graph.invoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"configurable": {"thread_id": f"quality:{thread_id}:{paper_id}"}},
        )
        raw = _last_ai_text(list(result.get("messages", [])))
        reasons, summary = _parse_reasons(raw)
        for dimension in QUALITY_DIMENSIONS:
            reasons.setdefault(dimension, "模型未提供该维度的解释。")
        overall = round(sum(scores.values()) / len(scores), 2)
        return QualityAssessment(paper_id, title, scores, overall, reasons, summary, evidence)


def _parse_reasons(raw: str) -> tuple[dict[str, str], str]:
    candidate = raw.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", candidate, re.S | re.I)
    if fence:
        candidate = fence.group(1)
    else:
        object_match = re.search(r"\{.*\}", candidate, re.S)
        if object_match:
            candidate = object_match.group(0)
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return {}, raw.strip() or "模型未返回质量评估理由。"
    reasons = {
        str(key): str(value)
        for key, value in payload.get("reasons", {}).items()
        if key in QUALITY_DIMENSIONS and str(value).strip()
    }
    return reasons, str(payload.get("summary", "")).strip()


def _last_ai_text(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, AIMessage) and not message.tool_calls:
            return str(message.content)
    return ""
