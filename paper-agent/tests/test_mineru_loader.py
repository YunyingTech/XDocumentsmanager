from __future__ import annotations

import json
from pathlib import Path

from core.mineru_loader import document_from_mineru_content
from tools.structure import extract_paper_structure


def test_mineru_content_restores_pages_abstract_objects_and_references(
    tmp_path: Path,
) -> None:
    result_dir = tmp_path / "paper" / "ocr"
    result_dir.mkdir(parents=True)
    content_path = result_dir / "paper_content_list.json"
    content_path.write_text(
        json.dumps(
            [
                {
                    "type": "text",
                    "text": "Test Paper",
                    "text_level": 1,
                    "bbox": [100, 20, 900, 80],
                    "page_idx": 0,
                },
                {
                    "type": "text",
                    "text": "This abstract contains enough evidence about the experiment. " * 3,
                    "bbox": [100, 100, 900, 300],
                    "page_idx": 0,
                },
                {
                    "type": "text",
                    "text": "Introduction—This paragraph states the motivation.",
                    "bbox": [100, 320, 900, 500],
                    "page_idx": 0,
                },
                {
                    "type": "image",
                    "image_caption": ["Experimental setup"],
                    "page_idx": 1,
                },
                {
                    "type": "list",
                    "sub_type": "ref_text",
                    "list_items": ["[1] A. Author, Example, 2026."],
                    "page_idx": 1,
                },
                {"type": "page_number", "text": "2", "page_idx": 1},
            ]
        ),
        encoding="utf-8",
    )
    (result_dir / "paper_middle.json").write_text(
        json.dumps(
            {
                "pdf_info": [
                    {
                        "page_idx": 0,
                        "page_size": [100, 200],
                        "para_blocks": [
                            {"type": "abstract", "bbox": [10, 20, 90, 60]}
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    document = document_from_mineru_content(content_path, filename="paper.pdf")
    sections = extract_paper_structure(document.text)

    assert document.extractor == "mineru-pipeline-ocr"
    assert len(document.pages) == 2
    assert document.page_for_offset(document.text.index("References")) == 2
    assert "Abstract" in document.text
    assert "Figure mineru-1: Experimental setup" in document.text
    assert {section.canonical for section in sections} >= {
        "abstract",
        "introduction",
        "references",
    }
