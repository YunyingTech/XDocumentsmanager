"""Rule-based bilingual paper section recognition."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any, Iterable


@dataclass(frozen=True, slots=True)
class Section:
    title: str
    level: int
    char_start: int
    page: int
    canonical: str
    number: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_CANONICAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("abstract", re.compile(r"^(?:abstract|summary|摘要)$", re.I)),
    ("introduction", re.compile(r"^(?:introduction|引言|绪论)$", re.I)),
    (
        "related_work",
        re.compile(
            r"^(?:related\s+work|background|literature\s+review|prior\s+work|相关工作|研究背景|文献综述)$",
            re.I,
        ),
    ),
    (
        "methods",
        re.compile(
            r"^(?:methods?|methodology|approach|proposed\s+(?:method|approach)|model|system|(?:model\s+)?architecture|方法|研究方法|方法论|模型|系统|系统架构)$",
            re.I,
        ),
    ),
    (
        "experiments",
        re.compile(
            r"^(?:experiments?|experimental\s+(?:setup|results)|evaluation|implementation|实验|实验设置|评估|实现)$",
            re.I,
        ),
    ),
    ("results", re.compile(r"^(?:results?|findings|结果|实验结果)$", re.I)),
    (
        "discussion",
        re.compile(r"^(?:discussion|analysis|limitations?|讨论|分析|局限性)$", re.I),
    ),
    (
        "conclusion",
        re.compile(
            r"^(?:conclusions?|discussion\s+and\s+conclusions?|concluding\s+remarks|conclusion\s+and\s+future\s+work|future\s+work|结论|总结|讨论与结论|结论与展望)$",
            re.I,
        ),
    ),
    (
        "references",
        re.compile(r"^(?:references|bibliography|works\s+cited|参考文献|引用文献)$", re.I),
    ),
)

_NUMBERED_HEADING = re.compile(
    r"^\s*(?P<number>(?:\d+(?:\.\d+){0,4}|[IVX]{1,5}))[.)]?\s+(?P<title>.+?)\s*$",
    re.I,
)
_CHINESE_NUMBERED_HEADING = re.compile(
    r"^\s*(?:第)?(?P<number>[一二三四五六七八九十百]+)(?:章|节|、|[.．])\s*(?P<title>.+?)\s*$"
)
_CAPTION_PREFIX = re.compile(r"^(?:fig(?:ure)?|table|algorithm|equation|图|表|公式)\s*[.\d一二三四五六七八九十]", re.I)
_RUN_IN_HEADING = re.compile(
    r"(?:^|(?<=[.!?。])\s+)(?P<title>[A-Za-z][A-Za-z &/]{1,60}|[\u4e00-\u9fff]{2,20})\s*[—–]\s*(?=\S)"
)


def extract_paper_structure(text: str) -> list[Section]:
    """Extract a page-aware section list without invoking an LLM."""
    if not text or not text.strip():
        return []

    sections: list[Section] = []
    page = 1
    for match in re.finditer(r"[^\n]*(?:\n|$)", text):
        raw_line = match.group(0)
        if not raw_line:
            continue
        page += raw_line.count("\f")
        line = re.sub(r"\s+", " ", raw_line.replace("\f", " ")).strip()
        run_ins = _run_in_headings(line)
        if run_ins:
            line_start = match.start() + max(0, raw_line.find(line))
            for title, canonical, relative_start in run_ins:
                sections.append(
                    Section(
                        title=title,
                        level=1,
                        char_start=line_start + relative_start,
                        page=page,
                        canonical=canonical,
                    )
                )
            continue
        if not _looks_like_heading(line):
            continue
        number, title = _split_heading(line)
        canonical = _canonical_name(title)
        if canonical is None and not _looks_like_generic_numbered_title(number, title):
            continue
        level = _heading_level(number)
        sections.append(
            Section(
                title=title,
                level=level,
                char_start=match.start() + raw_line.find(line),
                page=page,
                canonical=canonical or "other",
                number=number,
            )
        )
        if canonical == "references":
            break
    return _deduplicate_headings(sections)


def build_section_tree(sections: Iterable[Section]) -> list[dict[str, Any]]:
    """Convert the flat section sequence into nested serializable nodes."""
    roots: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    for section in sections:
        node = {**section.to_dict(), "children": []}
        while stack and int(stack[-1]["level"]) >= section.level:
            stack.pop()
        if stack:
            stack[-1]["children"].append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots


def section_accuracy(detected: Iterable[Section], expected: Iterable[str]) -> float:
    """Compute correct expected canonical sections divided by expected count."""
    expected_names = [name.strip().casefold() for name in expected if name.strip()]
    if not expected_names:
        return 1.0
    detected_names = {section.canonical.casefold() for section in detected}
    correct = sum(name in detected_names for name in expected_names)
    return correct / len(expected_names)


def _split_heading(line: str) -> tuple[str | None, str]:
    for pattern in (_NUMBERED_HEADING, _CHINESE_NUMBERED_HEADING):
        match = pattern.match(line)
        if match:
            return match.group("number").rstrip("."), match.group("title").strip(" :：")
    return None, line.strip(" :：")


def _canonical_name(title: str) -> str | None:
    normalized = re.sub(r"\s+", " ", title.strip(" .:：")).casefold()
    for canonical, pattern in _CANONICAL_PATTERNS:
        if pattern.fullmatch(normalized):
            return canonical
    return None


def _run_in_headings(line: str) -> list[tuple[str, str, int]]:
    headings: list[tuple[str, str, int]] = []
    for match in _RUN_IN_HEADING.finditer(line):
        title = match.group("title").strip()
        canonical = _canonical_name(title)
        if canonical is None and title.casefold() in {
            "acknowledgments",
            "acknowledgements",
            "致谢",
        }:
            canonical = "other"
        if canonical is not None:
            headings.append((title, canonical, match.start("title")))
    return headings


def _looks_like_heading(line: str) -> bool:
    if not line or len(line) > 120 or _CAPTION_PREFIX.match(line):
        return False
    if re.search(r"\.{3,}\s*\d+\s*$", line):
        return False
    if line.endswith((".", "。", "?", "!", ";")):
        return False
    return len(line.split()) <= 16


def _looks_like_generic_numbered_title(number: str | None, title: str) -> bool:
    if number is None or len(title) < 2 or len(title) > 80:
        return False
    if re.search(r"[=<>]|\b(?:et\s+al|doi)\b", title, re.I):
        return False
    if number and number[0].isdigit():
        try:
            if int(number.split(".", 1)[0]) > 20:
                return False
        except ValueError:
            return False
    if re.search(r"\b(?:university|institute|laboratory|research\s+center|@)\b", title, re.I):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", title)
    if not words:
        return bool(re.fullmatch(r"[\u4e00-\u9fff\s]{2,30}", title))
    title_case_words = sum(word[0].isupper() for word in words)
    return title_case_words / len(words) >= 0.5


def _heading_level(number: str | None) -> int:
    if number is None or re.fullmatch(r"[IVXLC]+|[一二三四五六七八九十百]+", number, re.I):
        return 1
    return min(5, number.count(".") + 1)


def _deduplicate_headings(sections: list[Section]) -> list[Section]:
    result: list[Section] = []
    seen: set[tuple[str | None, str, int]] = set()
    for section in sections:
        key = (section.number, section.title.casefold(), section.page)
        if key in seen:
            continue
        seen.add(key)
        result.append(section)
    return result
