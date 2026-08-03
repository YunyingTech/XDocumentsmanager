"""Section-aware chunking that preserves non-text paper objects as metadata."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import re
from typing import Any, Iterable

from core.pdf_loader import ImageRegion
from tools.structure import Section


DEFAULT_CHUNK_SIZE = 1200
DEFAULT_CHUNK_OVERLAP = 180


@dataclass(frozen=True, slots=True)
class ObjectPlaceholder:
    placeholder_id: str
    kind: str
    page: int
    char_start: int
    raw_text: str
    bbox: tuple[float, float, float, float] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class Chunk:
    chunk_id: str
    content: str
    section: str
    section_canonical: str
    page: int
    page_end: int
    para_idx: int
    char_start: int
    char_end: int
    placeholders: tuple[ObjectPlaceholder, ...] = ()

    @property
    def source_label(self) -> str:
        page_label = str(self.page) if self.page == self.page_end else f"{self.page}-{self.page_end}"
        return f"{self.section} / p.{page_label} / paragraph {self.para_idx}"


@dataclass(frozen=True, slots=True)
class _Paragraph:
    text: str
    page: int
    para_idx: int


_FIGURE_LINE = re.compile(r"^\s*(?:figure|fig\.?|图)\s*([\w.-]+)\s*[:：.]?\s*(.*)$", re.I)
_TABLE_LINE = re.compile(r"^\s*(?:table|表)\s*([\w.-]+)\s*[:：.]?\s*(.*)$", re.I)
_DISPLAY_FORMULA = re.compile(
    r"\$\$(.+?)\$\$|\\\[(.+?)\\\]|\\begin\{(?:equation\*?|align\*?)\}(.+?)\\end\{(?:equation\*?|align\*?)\}",
    re.S,
)
_INLINE_FORMULA = re.compile(r"\$(?=[^$\n]*(?:[=_^\\]|\\(?:alpha|beta|sum|prod)))([^$\n]+)\$")
_PLACEHOLDER_ID = re.compile(r"\[(?:FIGURE|TABLE|FORMULA):([^\]]+)\]")


def chunk_with_placeholders(
    sections: Iterable[Section],
    text: str,
    *,
    image_regions: Iterable[ImageRegion] = (),
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[Chunk]:
    """Split text by section and paragraph while retaining figures/tables/formulas."""
    if chunk_size < 200:
        raise ValueError("chunk_size must be at least 200 characters")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be non-negative and smaller than chunk_size")
    if not text or not text.strip():
        return []

    ranges = _section_ranges(list(sections), text)
    images = tuple(image_regions)
    chunks: list[Chunk] = []
    chunk_sequence = 0
    for section, start, end in ranges:
        section_text = text[start:end]
        transformed, objects = _replace_objects(
            section_text,
            base_offset=start,
            first_page=section.page,
            image_regions=(
                image
                for image in images
                if (
                    image.char_start is not None
                    and start <= image.char_start < end
                )
                or (
                    image.char_start is None
                    and section.page <= image.page <= _page_at(text, end)
                )
            ),
        )
        paragraphs = _paragraphs(transformed, section.page)
        for paragraph_group in _window_paragraphs(paragraphs, chunk_size, overlap):
            content = "\n\n".join(paragraph.text for paragraph in paragraph_group).strip()
            if not content:
                continue
            object_ids = set(_PLACEHOLDER_ID.findall(content))
            chunk_objects = tuple(obj for obj in objects if obj.placeholder_id in object_ids)
            digest = hashlib.sha256(
                f"{start}:{chunk_sequence}:{content}".encode("utf-8")
            ).hexdigest()[:20]
            chunks.append(
                Chunk(
                    chunk_id=f"chunk-{digest}",
                    content=content,
                    section=section.title,
                    section_canonical=section.canonical,
                    page=paragraph_group[0].page,
                    page_end=paragraph_group[-1].page,
                    para_idx=paragraph_group[0].para_idx,
                    char_start=start,
                    char_end=end,
                    placeholders=chunk_objects,
                )
            )
            chunk_sequence += 1
    return chunks


def _section_ranges(sections: list[Section], text: str) -> list[tuple[Section, int, int]]:
    ordered = sorted(
        (section for section in sections if 0 <= section.char_start < len(text)),
        key=lambda section: section.char_start,
    )
    if not ordered:
        general = Section("Full paper", 1, 0, 1, "other")
        return [(general, 0, len(text))]
    if ordered[0].char_start > 0 and text[: ordered[0].char_start].strip():
        ordered.insert(0, Section("Preamble", 1, 0, 1, "preamble"))
    return [
        (section, section.char_start, ordered[index + 1].char_start if index + 1 < len(ordered) else len(text))
        for index, section in enumerate(ordered)
    ]


def _replace_objects(
    text: str,
    *,
    base_offset: int,
    first_page: int,
    image_regions: Iterable[ImageRegion],
) -> tuple[str, tuple[ObjectPlaceholder, ...]]:
    objects: list[ObjectPlaceholder] = []
    sequence = {"figure": 0, "table": 0, "formula": 0}

    def display_replacement(match: re.Match[str]) -> str:
        raw = match.group(0)
        page = first_page + text[: match.start()].count("\f")
        return _register_object(objects, sequence, "formula", page, base_offset + match.start(), raw)

    transformed = _DISPLAY_FORMULA.sub(display_replacement, text)
    lines: list[str] = []
    cursor = 0
    page = first_page
    for raw_line in transformed.splitlines(keepends=True):
        line = raw_line.rstrip("\r\n")
        line_ending = raw_line[len(line) :]
        page += line.count("\f")
        visible_line = line.replace("\f", "").strip()
        figure = _FIGURE_LINE.match(visible_line)
        table = _TABLE_LINE.match(visible_line)
        if figure:
            replacement = _register_object(
                objects,
                sequence,
                "figure",
                page,
                base_offset + cursor,
                visible_line,
                preferred_id=figure.group(1),
            )
            lines.append(replacement + line_ending)
        elif table:
            replacement = _register_object(
                objects,
                sequence,
                "table",
                page,
                base_offset + cursor,
                visible_line,
                preferred_id=table.group(1),
            )
            lines.append(replacement + line_ending)
        elif _is_formula_line(visible_line):
            replacement = _register_object(
                objects, sequence, "formula", page, base_offset + cursor, visible_line
            )
            lines.append(replacement + line_ending)
        else:
            lines.append(line + line_ending)
        cursor += len(raw_line)
    transformed = "".join(lines)

    def inline_replacement(match: re.Match[str]) -> str:
        page_number = first_page + transformed[: match.start()].count("\f")
        return _register_object(
            objects,
            sequence,
            "formula",
            page_number,
            base_offset + match.start(),
            match.group(0),
        )

    transformed = _INLINE_FORMULA.sub(inline_replacement, transformed)
    existing_ids = {obj.placeholder_id for obj in objects}
    image_lines: list[str] = []
    for image in image_regions:
        placeholder_id = _safe_identifier(image.image_id)
        if placeholder_id in existing_ids:
            continue
        existing_ids.add(placeholder_id)
        object_kind = "table" if image.kind == "table" else "figure"
        objects.append(
            ObjectPlaceholder(
                placeholder_id=placeholder_id,
                kind=object_kind,
                page=image.page,
                char_start=image.char_start if image.char_start is not None else base_offset,
                raw_text=image.caption or "PDF image block",
                bbox=image.bbox,
            )
        )
        marker = "TABLE" if object_kind == "table" else "FIGURE"
        image_lines.append(f"[{marker}:{placeholder_id}]")
    if image_lines:
        transformed = transformed.rstrip() + "\n\n" + "\n".join(image_lines)
    return transformed, tuple(objects)


def _register_object(
    objects: list[ObjectPlaceholder],
    sequence: dict[str, int],
    kind: str,
    page: int,
    char_start: int,
    raw_text: str,
    *,
    preferred_id: str | None = None,
) -> str:
    sequence[kind] += 1
    suffix = _safe_identifier(preferred_id or str(sequence[kind]))
    placeholder_id = f"p{page}-{kind}-{suffix}"
    objects.append(
        ObjectPlaceholder(
            placeholder_id=placeholder_id,
            kind=kind,
            page=page,
            char_start=char_start,
            raw_text=raw_text.strip(),
        )
    )
    return f"[{kind.upper()}:{placeholder_id}]"


def _safe_identifier(value: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-.").lower()
    return safe or "object"


def _is_formula_line(line: str) -> bool:
    if len(line) < 3 or len(line) > 240:
        return False
    if not re.search(r"[=≈≠≤≥∑∏√]|\\(?:frac|sum|prod|int)", line):
        return False
    math_chars = len(re.findall(r"[=+\-*/_^≈≠≤≥∑∏√(){}\[\]\\]", line))
    words = len(re.findall(r"[A-Za-z]{4,}", line))
    return math_chars >= 2 or (math_chars >= 1 and words <= 3)


def _paragraphs(text: str, first_page: int) -> list[_Paragraph]:
    paragraphs: list[_Paragraph] = []
    para_idx = 1
    for page_offset, page_text in enumerate(text.split("\f")):
        page = first_page + page_offset
        blocks = re.split(r"\n\s*\n", page_text)
        for block in blocks:
            stripped = block.strip()
            if not stripped:
                continue
            paragraphs.append(_Paragraph(stripped, page, para_idx))
            para_idx += 1
    return paragraphs


def _window_paragraphs(
    paragraphs: list[_Paragraph], chunk_size: int, overlap: int
) -> list[list[_Paragraph]]:
    windows: list[list[_Paragraph]] = []
    current: list[_Paragraph] = []
    for paragraph in paragraphs:
        if len(paragraph.text) > chunk_size:
            if current:
                windows.append(current)
                current = []
            windows.extend(_split_long_paragraph(paragraph, chunk_size, overlap))
            continue
        projected = len("\n\n".join(item.text for item in [*current, paragraph]))
        if current and projected > chunk_size:
            windows.append(current)
            current = _overlap_tail(current, overlap)
            while current and len("\n\n".join(item.text for item in [*current, paragraph])) > chunk_size:
                current.pop(0)
        current.append(paragraph)
    if current:
        windows.append(current)
    return windows


def _split_long_paragraph(
    paragraph: _Paragraph, chunk_size: int, overlap: int
) -> list[list[_Paragraph]]:
    step = chunk_size - overlap
    return [
        [_Paragraph(paragraph.text[start : start + chunk_size], paragraph.page, paragraph.para_idx)]
        for start in range(0, len(paragraph.text), step)
        if paragraph.text[start : start + chunk_size].strip()
    ]


def _overlap_tail(paragraphs: list[_Paragraph], overlap: int) -> list[_Paragraph]:
    if overlap == 0:
        return []
    result: list[_Paragraph] = []
    size = 0
    for paragraph in reversed(paragraphs):
        if result and size + len(paragraph.text) > overlap:
            break
        result.insert(0, paragraph)
        size += len(paragraph.text) + 2
    return result


def _page_at(text: str, offset: int) -> int:
    return text.count("\f", 0, max(0, offset)) + 1
