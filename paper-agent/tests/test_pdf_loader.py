from __future__ import annotations

from io import BytesIO

import fitz
import pytest

from core.pdf_loader import (
    EmptyPaperError,
    InvalidPdfError,
    PaperTooLargeError,
    ScannedPaperError,
    UnsupportedFileTypeError,
    load_pdf,
)


def _pdf_bytes(*page_texts: str) -> bytes:
    document = fitz.open()
    for text in page_texts:
        page = document.new_page()
        page.insert_textbox(fitz.Rect(72, 72, 520, 760), text, fontsize=11)
    result = document.tobytes()
    document.close()
    return result


def test_load_pdf_preserves_pages_and_removes_repeated_margins() -> None:
    repeated = "Paper Reading Agent\n"
    paper = _pdf_bytes(
        repeated + "1 Introduction\n" + "This paper studies retrieval. " * 12 + "\nPage 1",
        repeated + "2 Methods\n" + "We use deterministic parsing. " * 12 + "\nPage 2",
    )

    loaded = load_pdf(BytesIO(paper), filename="agent.pdf")

    assert loaded.filename == "agent.pdf"
    assert len(loaded.pages) == 2
    assert loaded.page_for_offset(loaded.text.index("2 Methods")) == 2
    assert "Paper Reading Agent" not in loaded.text
    assert loaded.extractor == "pymupdf"


def test_load_pdf_rejects_non_pdf_and_missing_text_layer() -> None:
    with pytest.raises(InvalidPdfError, match="有效的 PDF"):
        load_pdf(b"not a pdf", filename="fake.pdf")

    blank = fitz.open()
    blank.new_page()
    blank_bytes = blank.tobytes()
    blank.close()
    with pytest.raises(ScannedPaperError, match="OCR"):
        load_pdf(blank_bytes, filename="scan.pdf")


def test_load_pdf_rejects_empty_wrong_extension_and_oversized_uploads() -> None:
    with pytest.raises(EmptyPaperError, match="为空"):
        load_pdf(b"", filename="empty.pdf")
    with pytest.raises(UnsupportedFileTypeError, match="仅支持 PDF"):
        load_pdf(b"%PDF-placeholder", filename="notes.txt")
    paper = _pdf_bytes("Enough text. " * 20)
    with pytest.raises(PaperTooLargeError, match="超过 0 MB"):
        load_pdf(paper, filename="large.pdf", max_size_mb=0)
