from tools.structure import build_section_tree, extract_paper_structure, section_accuracy


def test_extracts_numbered_english_sections_with_pages_and_levels() -> None:
    text = """Abstract
We study retrieval augmented generation.
1. Introduction
The introduction is body text and must not become another heading.
2 Related Work
Prior methods are reviewed.
3 Methods
Method body.
3.1 Retrieval Pipeline
Subsection body.
\f
4 Experiments
Experiment body.
5 Conclusion
Conclusion body.
References
[1] A reference.
"""

    sections = extract_paper_structure(text)

    assert [section.canonical for section in sections] == [
        "abstract",
        "introduction",
        "related_work",
        "methods",
        "other",
        "experiments",
        "conclusion",
        "references",
    ]
    assert sections[4].level == 2
    assert sections[5].page == 2
    assert section_accuracy(
        sections,
        ["abstract", "introduction", "related_work", "methods", "experiments", "conclusion", "references"],
    ) == 1.0


def test_extracts_chinese_sections_and_builds_a_tree() -> None:
    text = """摘要
本文提出一种论文阅读方法。
一、引言
正文。
二、相关工作
正文。
三、方法
正文。
3.1 检索模块
正文。
四、实验
正文。
五、结论
正文。
参考文献
[1] 示例。
"""

    sections = extract_paper_structure(text)
    tree = build_section_tree(sections)

    assert {section.canonical for section in sections} >= {
        "abstract",
        "introduction",
        "related_work",
        "methods",
        "experiments",
        "conclusion",
        "references",
    }
    methods = next(node for node in tree if node["canonical"] == "methods")
    assert methods["children"][0]["title"] == "检索模块"


def test_ignores_captions_toc_leaders_and_body_sentences() -> None:
    text = """Contents
1 Introduction ........ 2
Figure 1 Architecture
Table 2 Results
Our Methods improve prior results
1 Introduction
Body sentence.
"""

    sections = extract_paper_structure(text)

    assert [(section.canonical, section.page) for section in sections] == [("introduction", 1)]


def test_extracts_run_in_headings_used_by_compact_journal_papers() -> None:
    text = """Abstract
Compact abstract.
Introduction—The paper introduces its motivation in the same paragraph.
Model—The engine model is defined here.
System—The experimental apparatus is described here.
Result—Measurements support the model.
Discussion and Conclusion—The implications are summarized here.
Acknowledgments—The authors acknowledge funding.
References
[1] Example reference.
"""

    sections = extract_paper_structure(text)

    assert [section.canonical for section in sections] == [
        "abstract",
        "introduction",
        "methods",
        "methods",
        "results",
        "conclusion",
        "other",
        "references",
    ]
