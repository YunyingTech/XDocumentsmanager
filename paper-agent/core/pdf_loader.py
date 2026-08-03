"""Validated PDF extraction with page-aware, deterministic cleaning."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from io import BytesIO
from math import ceil
from pathlib import Path
import re
from typing import BinaryIO

import fitz
import pdfplumber


MIN_TEXT_CHARS = 80


class PaperLoadError(ValueError):
    """A user-facing PDF loading error."""


class EmptyPaperError(PaperLoadError):
    """Raised when an upload has no bytes."""


class InvalidPdfError(PaperLoadError):
    """Raised when an upload is not a readable PDF."""


class UnsupportedFileTypeError(PaperLoadError):
    """Raised when the uploaded filename is not a PDF."""


class PaperTooLargeError(PaperLoadError):
    """Raised when an upload exceeds the configured size limit."""


class ScannedPaperError(PaperLoadError):
    """Raised when a PDF has no usable text layer."""


@dataclass(frozen=True, slots=True)
class ImageRegion:
    image_id: str
    page: int
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class PageContent:
    page: int
    text: str
    images: tuple[ImageRegion, ...] = ()


@dataclass(frozen=True, slots=True)
class PaperDocument:
    filename: str
    text: str
    pages: tuple[PageContent, ...]
    page_offsets: tuple[int, ...]
    metadata: dict[str, str] = field(default_factory=dict)
    extractor: str = "pymupdf"

    def page_for_offset(self, char_offset: int) -> int:
        """Resolve a character offset in ``text`` to a one-based page number."""
        for index in range(len(self.page_offsets) - 1, -1, -1):
            if char_offset >= self.page_offsets[index]:
                return index + 1
        return 1


def load_pdf(
    source: str | Path | bytes | bytearray | BinaryIO,
    *,
    filename: str | None = None,
    max_size_mb: int = 50,
) -> PaperDocument:
    """Load and clean a PDF while preserving page and image metadata."""
    data, resolved_name = _read_source(source, filename)
    if not data:
        raise EmptyPaperError("上传文件为空，请选择包含内容的 PDF。")
    if Path(resolved_name).suffix.casefold() != ".pdf":
        raise UnsupportedFileTypeError("仅支持 PDF 文件，请重新选择。")
    if len(data) > max_size_mb * 1024 * 1024:
        raise PaperTooLargeError(f"PDF 超过 {max_size_mb} MB 限制，请压缩或拆分后重试。")
    if not data.lstrip().startswith(b"%PDF-"):
        raise InvalidPdfError("文件不是有效的 PDF，请检查扩展名和文件内容。")

    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise InvalidPdfError("PDF 无法打开，文件可能损坏或受到不支持的加密保护。") from exc

    try:
        if document.needs_pass:
            raise InvalidPdfError("PDF 受密码保护，请先移除密码后再上传。")
        if document.page_count == 0:
            raise EmptyPaperError("PDF 没有页面。")
        raw_pages, page_images = _extract_with_pymupdf(document)
        metadata = {
            str(key): str(value)
            for key, value in (document.metadata or {}).items()
            if value not in (None, "")
        }
    finally:
        document.close()

    extractor = "pymupdf"
    if _visible_char_count(raw_pages) < MIN_TEXT_CHARS:
        fallback_pages = _extract_with_pdfplumber(data)
        if _visible_char_count(fallback_pages) > _visible_char_count(raw_pages):
            raw_pages = fallback_pages
            extractor = "pdfplumber"

    cleaned_pages = _clean_pages(raw_pages)
    if _visible_char_count(cleaned_pages) < MIN_TEXT_CHARS:
        raise ScannedPaperError("PDF 缺少可用文本层，请先进行 OCR 后再上传。")

    pages = tuple(
        PageContent(page=index + 1, text=text, images=page_images[index])
        for index, text in enumerate(cleaned_pages)
    )
    full_text, page_offsets = _join_pages(cleaned_pages)
    return PaperDocument(
        filename=resolved_name,
        text=full_text,
        pages=pages,
        page_offsets=page_offsets,
        metadata=metadata,
        extractor=extractor,
    )


def _read_source(
    source: str | Path | bytes | bytearray | BinaryIO,
    filename: str | None,
) -> tuple[bytes, str]:
    if isinstance(source, (str, Path)):
        path = Path(source)
        try:
            return path.read_bytes(), filename or path.name
        except OSError as exc:
            raise PaperLoadError(f"无法读取 PDF：{path.name}") from exc
    if isinstance(source, (bytes, bytearray)):
        return bytes(source), filename or "uploaded-paper.pdf"
    try:
        data = source.read()
    except (AttributeError, OSError) as exc:
        raise PaperLoadError("无法读取上传内容。") from exc
    return bytes(data), filename or str(getattr(source, "name", "uploaded-paper.pdf"))


def _extract_with_pymupdf(
    document: fitz.Document,
) -> tuple[list[str], list[tuple[ImageRegion, ...]]]:
    texts: list[str] = []
    images_by_page: list[tuple[ImageRegion, ...]] = []
    for page_index, page in enumerate(document):
        texts.append(page.get_text("text", sort=True) or "")
        image_regions: list[ImageRegion] = []
        page_dict = page.get_text("dict", sort=True)
        for block_index, block in enumerate(page_dict.get("blocks", []), start=1):
            if block.get("type") != 1:
                continue
            bbox = tuple(float(value) for value in block.get("bbox", (0, 0, 0, 0)))
            image_regions.append(
                ImageRegion(
                    image_id=f"p{page_index + 1}-img{block_index}",
                    page=page_index + 1,
                    bbox=bbox,  # type: ignore[arg-type]
                )
            )
        images_by_page.append(tuple(image_regions))
    return texts, images_by_page


def _extract_with_pdfplumber(data: bytes) -> list[str]:
    try:
        with pdfplumber.open(BytesIO(data)) as document:
            return [page.extract_text(layout=True) or "" for page in document.pages]
    except Exception:
        return []


def _visible_char_count(pages: list[str]) -> int:
    return sum(len(re.sub(r"\s+", "", page)) for page in pages)


def _clean_pages(pages: list[str]) -> list[str]:
    normalized = [_normalize_lines(page) for page in pages]
    if len(normalized) < 2:
        return normalized

    page_lines = [[line for line in page.splitlines() if line.strip()] for page in normalized]
    threshold = max(2, ceil(len(page_lines) * 0.5))
    top_candidates = Counter(
        _margin_key(line)
        for lines in page_lines
        for line in lines[:2]
        if _is_margin_candidate(line)
    )
    bottom_candidates = Counter(
        _margin_key(line)
        for lines in page_lines
        for line in lines[-2:]
        if _is_margin_candidate(line)
    )
    repeated = {
        key
        for key, count in (top_candidates + bottom_candidates).items()
        if count >= threshold
    }
    if not repeated:
        return normalized

    cleaned: list[str] = []
    for page in normalized:
        lines = page.splitlines()
        kept = [line for line in lines if _margin_key(line) not in repeated]
        cleaned.append("\n".join(kept).strip())
    return cleaned


def _normalize_lines(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00ad", "")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    merged: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if (
            line.endswith("-")
            and index + 1 < len(lines)
            and re.match(r"^[a-z]", lines[index + 1])
        ):
            lines[index + 1] = line[:-1] + lines[index + 1]
        else:
            merged.append(line)
        index += 1
    return re.sub(r"\n{3,}", "\n\n", "\n".join(merged)).strip()


def _margin_key(line: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", line.strip().casefold()))


def _is_margin_candidate(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and len(stripped) <= 100


def _join_pages(pages: list[str]) -> tuple[str, tuple[int, ...]]:
    parts: list[str] = []
    offsets: list[int] = []
    cursor = 0
    for page_index, page in enumerate(pages):
        if page_index:
            separator = "\n\f\n"
            parts.append(separator)
            cursor += len(separator)
        offsets.append(cursor)
        parts.append(page)
        cursor += len(page)
    return "".join(parts), tuple(offsets)
