"""Deterministic multi-paper method, dataset, and metric comparison."""

from __future__ import annotations

from dataclasses import dataclass
import re

from core.store import PaperVectorStore


@dataclass(frozen=True, slots=True)
class PaperComparison:
    paper_id: str
    title: str
    method: str
    datasets: tuple[str, ...]
    metrics: tuple[str, ...]


_KNOWN_DATASETS = re.compile(
    r"\b(?:ImageNet|CIFAR-?10|CIFAR-?100|MNIST|SQuAD(?:\s*2\.0)?|HotpotQA|Natural Questions|MS\s*MARCO|MTEB|COCO|WikiText-?103|GLUE|SuperGLUE|PubMedQA|arXiv)\b",
    re.I,
)
_DATASET_PHRASE = re.compile(
    r"\b([A-Z][A-Za-z0-9_-]{2,}(?:\s+[A-Z][A-Za-z0-9_-]{2,}){0,2})\s+(?:dataset|corpus|benchmark)\b"
)
_METRICS = re.compile(
    r"\b(?:accuracy|precision|recall|F1(?:-score)?|BLEU|ROUGE(?:-[L12])?|AUC|AUROC|MRR|NDCG(?:@\d+)?|MAP|Recall@\d+|Hit@\d+|perplexity|exact match|EM)\b",
    re.I,
)


def compare_papers(store: PaperVectorStore, paper_ids: list[str]) -> str:
    unique_ids = list(dict.fromkeys(identifier.strip() for identifier in paper_ids if identifier.strip()))
    if not 2 <= len(unique_ids) <= 3:
        raise ValueError("批量对比必须选择 2 到 3 篇不同论文。")
    comparisons = [_summarize_paper(store, paper_id) for paper_id in unique_ids]
    rows = [
        "| 论文 | 方法 | 数据集 / 基准 | 指标 |",
        "|---|---|---|---|",
    ]
    for item in comparisons:
        rows.append(
            f"| {_escape(item.title)} | {_escape(item.method)} | "
            f"{_escape(', '.join(item.datasets) or '未明确识别')} | "
            f"{_escape(', '.join(item.metrics) or '未明确识别')} |"
        )
    return "\n".join(rows)


def _summarize_paper(store: PaperVectorStore, paper_id: str) -> PaperComparison:
    records = store.records_for_paper(paper_id)
    if not records:
        raise ValueError(f"论文 {paper_id} 尚未入库。")
    title = str(records[0]["metadata"].get("paper_title", paper_id))
    documents = [str(record["document"]) for record in records]
    method_documents = [
        str(record["document"])
        for record in records
        if str(record["metadata"].get("section_canonical")) == "methods"
    ] or documents
    method = _method_sentence(" ".join(method_documents))
    whole_text = " ".join(documents)
    datasets = _ordered_unique(
        [match.group(0) for match in _KNOWN_DATASETS.finditer(whole_text)]
        + [match.group(1) for match in _DATASET_PHRASE.finditer(whole_text)]
    )
    metrics = _ordered_unique(match.group(0) for match in _METRICS.finditer(whole_text))
    return PaperComparison(paper_id, title, method, tuple(datasets[:8]), tuple(metrics[:8]))


def _method_sentence(text: str) -> str:
    clean = re.sub(r"\[[A-Z]+:[^\]]+\]", "", re.sub(r"\s+", " ", text)).strip()
    sentences = re.split(r"(?<=[.!?。！？])\s+", clean)
    preferred = next(
        (
            sentence
            for sentence in sentences
            if re.search(r"\b(?:propose|present|introduce|use|employ|architecture|model|method)\b|提出|采用|方法|模型", sentence, re.I)
        ),
        sentences[0] if sentences else "未明确识别",
    )
    return preferred[:320].strip() or "未明确识别"


def _ordered_unique(values) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = re.sub(r"\s+", " ", str(value)).strip()
        key = normalized.casefold()
        if normalized and key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
