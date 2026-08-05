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
    r"(?m)(?:^|\f)\s*(?:(?P<bracket>\[(?P<bracket_num>\d+)\])|(?P<paren>\((?P<paren_num>\d+)\))|(?P<plain>(?P<plain_num>\d+)[.)]))\s*"
)
_ENTRY_INLINE = re.compile(
    r"(?<=[^\w])(?:(?P<bracket>\[(?P<bracket_num>\d+)\])|(?P<paren>\((?P<paren_num>\d+)\))|(?P<plain>(?P<plain_num>\d+)[.)]))(?=\s|$)"
)
_YEAR = re.compile(r"\b((?:18|19|20)\d{2}[a-z]?)\b", re.I)
_PROTECTED_AL = re.compile(r"\bet al\.", re.I)
_PROTECTED_AL_PLACEHOLDER = "\x00ETAL\x00"


def extract_references(
    text: str,
    sections: Iterable[Section] | None = None,
) -> ReferenceReport:
    detected = list(sections) if sections is not None else extract_paper_structure(text)
    reference_section = next(
        (section for section in detected if section.canonical == "references"), None
    )
    if reference_section is None:
        reference_section = _detect_reference_section(text)
    if reference_section is None:
        return ReferenceReport(
            (),
            (FormatIssue(None, "references_missing", "未识别到参考文献章节。", "error"),),
            False,
        )
    body = text[reference_section.char_start :]
    first_newline = body.find("\n")
    candidate = body[first_newline + 1 :] if first_newline >= 0 else ""
    matches = [m for m in _ENTRY_START.finditer(candidate) if _is_valid_marker_index(_marker(m)[0])]
    if not matches:
        matches = [m for m in _ENTRY_START.finditer(body) if _is_valid_marker_index(_marker(m)[0])]
    body = candidate if matches else body

    # Also look for inline markers (e.g. right-column entries in two-column layouts)
    line_markers: list[tuple[int, int, int, str]] = []
    for m in matches:
        idx, style = _marker(m)
        line_markers.append((m.start(), m.end(), idx, style))

    # Search between line-start markers for inline entries
    inline_markers: list[tuple[int, int, int, str]] = []
    for i in range(len(line_markers)):
        gap_start = line_markers[i][1]
        gap_end = line_markers[i + 1][0] if i + 1 < len(line_markers) else len(body)
        for m in _ENTRY_INLINE.finditer(body[gap_start:gap_end]):
            idx, style = _marker(m)
            # Skip year-like numbers (1800+) to avoid splitting on in-text years
            if idx >= 1800:
                continue
            # Only treat as a reference entry if the number is larger than the
            # previous line-start marker (avoids truncating on in-text citations like [1])
            if idx > line_markers[i][2]:
                inline_markers.append((gap_start + m.start(), gap_start + m.end(), idx, style))

    # Combine and sort by position
    all_markers = sorted(line_markers + inline_markers, key=lambda x: x[0])
    # Deduplicate by index, keeping the first occurrence
    seen: set[int] = set()
    deduped: list[tuple[int, int, int, str]] = []
    for start, end, idx, style in all_markers:
        if idx in seen:
            continue
        seen.add(idx)
        deduped.append((start, end, idx, style))

    entries: list[ReferenceEntry] = []
    for position, (start, end, idx, style) in enumerate(deduped):
        next_start = deduped[position + 1][0] if position + 1 < len(deduped) else len(body)
        raw = re.sub(r"\s+", " ", body[end:next_start]).strip()
        entries.append(_parse_reference(idx, style, raw))
    # Sort by index for consistent output; unnumbered entries keep their original order
    entries.sort(key=lambda e: (e.index is None, e.index or 0))
    if not entries and body.strip():
        paragraphs = re.split(r"\n\s*\n", body)
        if len(paragraphs) == 1 and len(body.splitlines()) > 2:
            for index, line in enumerate(body.splitlines(), start=1):
                raw = re.sub(r"\s+", " ", line).strip()
                if raw and len(raw) > 20 and not raw.lower().startswith("references"):
                    entries.append(_parse_reference(None, "unnumbered", raw))
        else:
            for index, paragraph in enumerate(paragraphs, start=1):
                raw = re.sub(r"\s+", " ", paragraph).strip()
                if raw and not raw.lower().startswith("references"):
                    entries.append(_parse_reference(None, "unnumbered", raw))
    issues = _format_issues(entries)
    if not entries:
        issues.append(FormatIssue(None, "references_empty", "参考文献章节中没有可解析条目。", "error"))
    return ReferenceReport(tuple(entries), tuple(issues), True)


def _detect_reference_section(text: str) -> Section | None:
    """Detect a reference list even without an explicit 'References' heading."""
    all_matches = [m for m in _ENTRY_START.finditer(text) if _is_valid_marker_index(_marker(m)[0])]
    if len(all_matches) < 2:
        return None
    indices = [
        int(m.group("bracket_num") or m.group("paren_num") or m.group("plain_num"))
        for m in all_matches
    ]
    # Find the longest consecutive sequence starting near 1
    best_start = 0
    best_len = 0
    for i in range(len(indices)):
        length = 1
        for j in range(i + 1, len(indices)):
            if indices[j] == indices[j - 1] + 1:
                length += 1
            else:
                break
        if length > best_len and indices[i] <= 3:
            best_len = length
            best_start = i
    if best_len < 2:
        return None
    # Reject if the best sequence looks like in-text citations (very short gaps)
    first_match = all_matches[best_start]
    last_match = all_matches[best_start + best_len - 1]
    avg_gap = (last_match.start() - first_match.start()) / max(1, best_len - 1)
    if avg_gap < 30:
        # Likely in-text citations like "[1] [2] [3]" rather than a reference list
        return None
    start_pos = first_match.start()
    # Look backwards for a blank line to bound the section start
    preceding = text[max(0, start_pos - 500) : start_pos]
    last_double_newline = preceding.rfind("\n\n")
    if last_double_newline >= 0:
        start_pos = max(0, start_pos - 500) + last_double_newline + 2
    else:
        # Try a single form-feed or newline as boundary
        last_break = max(preceding.rfind("\f"), preceding.rfind("\n"))
        if last_break >= 0:
            start_pos = max(0, start_pos - 500) + last_break + 1
    return Section("References", 1, start_pos, 1, "references")


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


def _is_valid_marker_index(idx: int) -> bool:
    """Reject year-like numbers that are accidentally matched as plain markers."""
    return idx < 1800


def _parse_reference(index: int | None, style: str, raw: str) -> ReferenceEntry:
    # Truncate before any inline marker that was missed during pre-processing
    inline = _ENTRY_INLINE.search(raw)
    if inline:
        raw = raw[: inline.start()].strip()
    protected = _PROTECTED_AL.sub(_PROTECTED_AL_PLACEHOLDER, raw)
    year_match = _YEAR.search(protected)
    year = year_match.group(1) if year_match else None
    segments = [segment.strip(" ,;") for segment in re.split(r"\.\s+", protected) if segment.strip()]
    authors: str | None = None
    title: str | None = None
    venue: str | None = None
    if year_match:
        before = protected[: year_match.start()].strip(" .,:;()")
        after = protected[year_match.end() :].strip(" .,:;()")
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
    # Restore protected placeholders
    if authors:
        authors = authors.replace(_PROTECTED_AL_PLACEHOLDER, "et al.")
    if title:
        title = title.replace(_PROTECTED_AL_PLACEHOLDER, "et al.")
    if venue:
        venue = venue.replace(_PROTECTED_AL_PLACEHOLDER, "et al.")
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
