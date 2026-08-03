from core.pdf_loader import ImageRegion
from tools.chunking import chunk_with_placeholders
from tools.structure import extract_paper_structure


def test_chunking_preserves_figure_table_formula_and_image_metadata() -> None:
    text = """1 Introduction
This paper introduces a retrieval method.

Figure 1: System architecture

Table 2: Main benchmark results

E = mc^2 + alpha

The objective is $L = x_1 + x_2$ and is optimized during training.

2 Methods
""" + ("The retriever selects evidence paragraphs. " * 30)
    sections = extract_paper_structure(text)
    image = ImageRegion("p1-img9", 1, (10.0, 20.0, 100.0, 200.0))

    chunks = chunk_with_placeholders(
        sections,
        text,
        image_regions=[image],
        chunk_size=400,
        overlap=60,
    )

    combined = "\n".join(chunk.content for chunk in chunks)
    objects = {
        placeholder.kind: placeholder
        for chunk in chunks
        for placeholder in chunk.placeholders
    }
    assert "[FIGURE:" in combined
    assert "[TABLE:" in combined
    assert "[FORMULA:" in combined
    assert objects["table"].raw_text.startswith("Table 2")
    assert any(placeholder.bbox == image.bbox for chunk in chunks for placeholder in chunk.placeholders)
    assert len(chunks) >= 3


def test_chunking_is_section_aware_and_validates_window_settings() -> None:
    text = "Abstract\n" + ("Summary sentence. " * 20) + "\n\n1 Introduction\n" + ("Body. " * 100)
    sections = extract_paper_structure(text)

    chunks = chunk_with_placeholders(sections, text, chunk_size=240, overlap=40)

    assert {chunk.section_canonical for chunk in chunks} >= {"abstract", "introduction"}
    assert all(chunk.page >= 1 and chunk.page_end >= chunk.page for chunk in chunks)

    try:
        chunk_with_placeholders(sections, text, chunk_size=100, overlap=10)
    except ValueError as exc:
        assert "chunk_size" in str(exc)
    else:
        raise AssertionError("invalid chunk size must fail")
