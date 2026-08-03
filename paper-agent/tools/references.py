"""Deterministic reference extraction and formatting diagnostics."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any, Iterable

from tools.structure import Section, extract_paper_structure


@dataclass(frozen=True, slots=True)
class ReferenceEntry:
    index: int | None
    marker_style: str
    raw: str
    authors: str | None
    year: str | None
    title: str | None
    venue: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class FormatIssue:
    entry: int | None
    code: str
    message: str
    severity: str = "warning"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ReferenceReport:
    references: tuple[ReferenceEntry, ...]
    format_issues: tuple[FormatIssue, ...]
    section_found: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "references": [reference.to_dict() for reference in self.references],
            "format_issues": [issue.to_dict() for issue in self.format_issues],
            "section_found": self.section_found,
        }


_ENTRY_START = re.compile(
    r"(?m)^\s*(?:(?P<bracket>\[(?P<bracket_num>\d+)\])|(?P<paren>\((?P<paren_num>\d+)\))|(?P<plain>(?P<plain_num>\d+)[.)]))\s+"
)
_YEAR = re.compile(r"\b((?:18|19|20)\d{2}[a-z]?)\b", re.I)


def extract_references(
    text: str,
    sections: Iterable[Section] | None = None,
) -> ReferenceReport:
    detected = list(sections) if sections is not None else extract_paper_structure(text)
    reference_section = next(
        (section for section in detected if section.canonical == "references"), None
    )
    if reference_section is None:
        return ReferenceReport(
            (),
            (FormatIssue(None, "references_missing", "未识别到参考文献章节。", "error"),),
            False,
        )
    body = text[reference_section.char_start :]
    first_newline = body.find("\n")
    body = body[first_newline + 1 :] if first_newline >= 0 else ""
    matches = list(_ENTRY_START.finditer(body))
    entries: list[ReferenceEntry] = []
    for position, match in enumerate(matches):
        end = matches[position + 1].start() if position + 1 < len(matches) else len(body)
        raw = re.sub(r"\s+", " ", body[match.end() : end]).strip()
        index, style = _marker(match)
        entries.append(_parse_reference(index, style, raw))
    if not entries and body.strip():
        for index, paragraph in enumerate(re.split(r"\n\s*\n", body), start=1):
            raw = re.sub(r"\s+", " ", paragraph).strip()
            if raw:
                entries.append(_parse_reference(None, "unnumbered", raw))
    issues = _format_issues(entries)
    if not entries:
        issues.append(FormatIssue(None, "references_empty", "参考文献章节中没有可解析条目。", "error"))
    return ReferenceReport(tuple(entries), tuple(issues), True)


def report_as_markdown(report: ReferenceReport) -> str:
    if not report.section_found:
        return "### 参考文献检查\n\n未识别到参考文献章节。"
    rows = ["| # | 作者 | 年份 | 标题 | 出处 |", "|---:|---|---|---|---|"]
    for reference in report.references:
        rows.append(
            "| {index} | {authors} | {year} | {title} | {venue} |".format(
                index=reference.index if reference.index is not None else "-",
                authors=_escape(reference.authors or "缺失"),
                year=reference.year or "缺失",
                title=_escape(reference.title or "缺失"),
                venue=_escape(reference.venue or "缺失"),
            )
        )
    if report.format_issues:
        rows.extend(["", "**格式问题**"])
        rows.extend(f"- {issue.message}" for issue in report.format_issues)
    else:
        rows.extend(["", "未发现规则层面的格式问题。"])
    return "\n".join(rows)


def _marker(match: re.Match[str]) -> tuple[int, str]:
    if match.group("bracket"):
        return int(match.group("bracket_num")), "bracket"
    if match.group("paren"):
        return int(match.group("paren_num")), "parenthesis"
    return int(match.group("plain_num")), "plain"


def _parse_reference(index: int | None, style: str, raw: str) -> ReferenceEntry:
    year_match = _YEAR.search(raw)
    year = year_match.group(1) if year_match else None
    segments = [segment.strip(" ,;") for segment in re.split(r"\.\s+", raw) if segment.strip()]
    authors: str | None = None
    title: str | None = None
    venue: str | None = None
    if year_match:
        before = raw[: year_match.start()].strip(" .,:;()")
        after = raw[year_match.end() :].strip(" .,:;()")
        authors = before or (segments[0] if segments else None)
        after_segments = [segment.strip(" ,;") for segment in re.split(r"\.\s+", after) if segment.strip()]
        title = after_segments[0] if after_segments else None
        venue = ". ".join(after_segments[1:]) or None
    elif segments:
        authors = segments[0]
        title = segments[1] if len(segments) > 1 else None
        venue = ". ".join(segments[2:]) or None
    if authors and len(authors.split()) < 2:
        authors = None
    if title and len(title) < 4:
        title = None
    return ReferenceEntry(index, style, raw, authors, year, title, venue)


def _format_issues(entries: list[ReferenceEntry]) -> list[FormatIssue]:
    issues: list[FormatIssue] = []
    styles = {entry.marker_style for entry in entries}
    if len(styles) > 1:
        issues.append(FormatIssue(None, "mixed_markers", "参考文献编号样式不一致。"))
    numbered = [entry.index for entry in entries if entry.index is not None]
    if numbered and numbered != list(range(1, len(numbered) + 1)):
        issues.append(FormatIssue(None, "nonsequential_numbers", "参考文献编号不连续或未从 1 开始。"))
    endings = {entry.raw.rstrip()[-1:] in {".", "。"} for entry in entries if entry.raw.rstrip()}
    if len(endings) > 1:
        issues.append(FormatIssue(None, "mixed_end_punctuation", "参考文献末尾标点不一致。"))
    for position, entry in enumerate(entries, start=1):
        label = entry.index if entry.index is not None else position
        for field_name, value, label_name in (
            ("authors", entry.authors, "作者"),
            ("year", entry.year, "年份"),
            ("title", entry.title, "标题"),
            ("venue", entry.venue, "出处"),
        ):
            if not value:
                issues.append(
                    FormatIssue(label, f"missing_{field_name}", f"参考文献 {label} 缺少可解析的{label_name}。")
                )
    return issues


def _escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
