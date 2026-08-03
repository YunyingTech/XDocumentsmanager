from pathlib import Path

import pytest

from core.pdf_loader import load_pdf
from tools.structure import extract_paper_structure, section_accuracy


PAPERS_DIR = Path(__file__).resolve().parents[1] / "data" / "papers"


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        (
            "rag-2005.11401.pdf",
            [
                "abstract",
                "introduction",
                "methods",
                "experiments",
                "results",
                "related_work",
                "discussion",
                "references",
            ],
        ),
        (
            "transformer-1706.03762.pdf",
            [
                "abstract",
                "introduction",
                "related_work",
                "methods",
                "results",
                "conclusion",
                "references",
            ],
        ),
    ],
)
def test_real_paper_core_section_accuracy_is_at_least_90_percent(
    filename: str, expected: list[str]
) -> None:
    document = load_pdf(PAPERS_DIR / filename, max_size_mb=20)
    sections = extract_paper_structure(document.text)

    accuracy = section_accuracy(sections, expected)

    assert accuracy >= 0.9, (
        filename,
        accuracy,
        [section.canonical for section in sections],
    )
