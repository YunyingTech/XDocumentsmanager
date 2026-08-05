"""Tests for reference extraction fixes."""

from tools.references import extract_references, report_as_markdown


def test_references_and_notes_heading_is_recognized() -> None:
    text = """1 Introduction
Body.
References and Notes
[1] A. Author and B. Writer. 2020. Reliable Retrieval. Journal of AI.
[2] C. Researcher. 2021. Another Study. Conference Name.
"""
    report = extract_references(text)
    assert report.section_found is True
    assert len(report.references) == 2
    assert report.references[0].index == 1
    assert report.references[1].index == 2


def test_no_heading_reference_list_is_detected() -> None:
    text = """1 Introduction
Body with a citation [1] and another [2].

Acknowledgments
We thank everyone.

[1] A. Author and B. Writer. 2020. Reliable Retrieval. Journal of AI.
[2] C. Researcher. 2021. Another Study. Conference Name.
[3] D. Scientist. 2022. Third Paper. Journal.
"""
    report = extract_references(text)
    assert report.section_found is True
    assert len(report.references) == 3
    assert [r.index for r in report.references] == [1, 2, 3]


def test_two_column_inline_markers_are_extracted() -> None:
    # Simulates a two-column layout where entries [1]-[4] are line-start
    # and [5]-[8] appear inline on the same lines.
    text = """References
[1] A. Author. 2020. Title One. Journal A. [5] E. Researcher. 2021. Title Five. Journal E.
[2] B. Writer. 2019. Title Two. Journal B. [6] F. Scientist. 2022. Title Six. Journal F.
[3] C. Scholar. 2018. Title Three. Journal C. [7] G. Academic. 2020. Title Seven. Journal G.
[4] D. Scientist. 2017. Title Four. Journal D. [8] H. Professor. 2019. Title Eight. Journal H.
"""
    report = extract_references(text)
    assert report.section_found is True
    assert len(report.references) == 8
    indices = [r.index for r in report.references]
    assert indices == [1, 2, 3, 4, 5, 6, 7, 8]


def test_form_feed_cross_page_marker_is_matched() -> None:
    text = "References\n[1] A. Author. 2020. Title. Journal.\n\f\n[2] B. Writer. 2021. Title. Journal.\n"
    report = extract_references(text)
    assert report.section_found is True
    assert len(report.references) == 2
    assert report.references[1].index == 2


def test_report_as_markdown_for_detected_section() -> None:
    text = """1 Introduction
Body.

[1] A. Author. 2020. Title. Journal.
[2] B. Writer. 2021. Title. Journal.
"""
    report = extract_references(text)
    assert report.section_found is True
    md = report_as_markdown(report)
    assert "未识别到参考文献章节" not in md
    assert "Author" in md
    assert "Writer" in md


def test_year_numbers_are_not_treated_as_inline_markers() -> None:
    text = """References
[1] A. Author. 2020. Reliable Retrieval. Journal of AI.
[2] C. Researcher. 2021. Another Study. Conference Name.
"""
    report = extract_references(text)
    assert len(report.references) == 2
    for r in report.references:
        assert r.index < 1800


def test_in_text_citations_do_not_trigger_false_detection() -> None:
    text = (
        "1 Introduction\n"
        "As shown in [1] and [2], the method works well [3].\n"
        "2 Methods\n"
        "We follow prior work [1] and [2].\n"
        "3 Experiments\n"
        "Results are good.\n"
        "4 Discussion\n"
        "More discussion here.\n"
        "5 Conclusion\n"
        "In conclusion, the results are promising.\n"
    )
    report = extract_references(text)
    # In-text citations in the first third should not trigger detection
    assert report.section_found is False
