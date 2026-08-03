"""MineU OCR/layout fallback with persistent, content-addressed results."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

from core.pdf_loader import PageContent, PaperDocument, PaperLoadError


class MinerUExtractionError(PaperLoadError):
    """Raised when MineU cannot produce usable structured text."""


_IGNORED_TYPES = {
    "header",
    "footer",
    "page_header",
    "page_footer",
    "page_number",
    "aside_text",
    "page_aside_text",
    "page_footnote",
}


def load_pdf_with_mineru(
    source: str | Path,
    *,
    cache_dir: str | Path,
    timeout_seconds: int = 1800,
    language: str = "en",
) -> PaperDocument:
    """Run MineU's CPU OCR pipeline and convert its content list to a document."""
    source_path = Path(source).resolve()
    if not source_path.is_file():
        raise MinerUExtractionError("MineU 无法读取待处理 PDF。")

    digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    output_dir = Path(cache_dir).resolve() / digest
    content_list = _find_content_list(output_dir)
    if content_list is None:
        _run_mineru(
            source_path,
            output_dir,
            timeout_seconds=timeout_seconds,
            language=language,
        )
        content_list = _find_content_list(output_dir)
    if content_list is None:
        raise MinerUExtractionError("MineU OCR 已结束，但没有生成结构化文本。")
    return document_from_mineru_content(content_list, filename=source_path.name)


def document_from_mineru_content(
    content_list_path: str | Path,
    *,
    filename: str,
) -> PaperDocument:
    """Build page-aware text from a MineU ``content_list.json`` artifact."""
    path = Path(content_list_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MinerUExtractionError("MineU 结构化结果无法读取。") from exc
    if not isinstance(payload, list):
        raise MinerUExtractionError("MineU 结构化结果格式无效。")

    abstract_regions = _abstract_regions(path)
    pages: dict[int, list[str]] = {}
    references_started = False
    visual_sequence = 0
    ordered_items = sorted(
        enumerate(payload),
        key=lambda entry: (
            _as_int(entry[1].get("page_idx"), 0)
            if isinstance(entry[1], dict)
            else 0,
            _is_reference_item(entry[1]),
            entry[0],
        ),
    )
    for _, item in ordered_items:
        if not isinstance(item, dict):
            continue
        page_index = max(0, _as_int(item.get("page_idx"), 0))
        item_type = str(item.get("type", "")).casefold()
        if item_type in _IGNORED_TYPES:
            continue
        page_parts = pages.setdefault(page_index, [])

        if _matches_region(item, page_index, abstract_regions):
            page_parts.append("Abstract")

        if item_type == "list" and item.get("sub_type") == "ref_text":
            if not references_started:
                page_parts.append("References")
                references_started = True
            text = "\n".join(
                str(entry).strip()
                for entry in item.get("list_items", [])
                if str(entry).strip()
            )
        elif item_type in {"image", "chart"}:
            visual_sequence += 1
            caption = _caption_text(item, "image_caption", "chart_caption")
            text = f"Figure mineru-{visual_sequence}: {caption}".rstrip()
        elif item_type == "table":
            visual_sequence += 1
            caption = _caption_text(item, "table_caption")
            table_body = _plain_html(str(item.get("table_body", "")))
            text = f"Table mineru-{visual_sequence}: {caption or table_body}".rstrip()
        elif item_type == "equation":
            equation = str(item.get("text", "")).strip()
            text = f"$$\n{equation}\n$$" if equation else ""
        else:
            text = str(item.get("text", "")).strip()

        if text:
            page_parts.append(text)

    if not pages:
        raise MinerUExtractionError("MineU OCR 没有提取到可用文本。")
    page_count = max(pages) + 1
    page_texts = ["\n\n".join(pages.get(index, [])).strip() for index in range(page_count)]
    full_text, offsets = _join_pages(page_texts)
    if len(re.sub(r"\s+", "", full_text)) < 80:
        raise MinerUExtractionError("MineU OCR 提取文本过少，无法建立论文索引。")

    return PaperDocument(
        filename=filename,
        text=full_text,
        pages=tuple(
            PageContent(page=index + 1, text=text)
            for index, text in enumerate(page_texts)
        ),
        page_offsets=offsets,
        metadata={
            "extractor": "MineU 3.4.4",
            "content_list": str(path),
        },
        extractor="mineru-pipeline-ocr",
    )


def _run_mineru(
    source: Path,
    output_dir: Path,
    *,
    timeout_seconds: int,
    language: str,
) -> None:
    if importlib.util.find_spec("mineru") is None:
        raise MinerUExtractionError(
            "需要 MineU OCR，但当前环境未安装。请重新执行 pip install -r requirements.txt。"
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "mineru.cli.client",
        "-p",
        str(source),
        "-o",
        str(output_dir),
        "-b",
        "pipeline",
        "-m",
        "ocr",
        "-l",
        language,
    ]
    environment = os.environ.copy()
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    environment.setdefault("MINERU_LOG_LEVEL", "INFO")
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=max(60, timeout_seconds),
            creationflags=creation_flags,
        )
    except subprocess.TimeoutExpired as exc:
        raise MinerUExtractionError(
            f"MineU OCR 超过 {timeout_seconds} 秒，请稍后重试或提高 MINERU_TIMEOUT_SECONDS。"
        ) from exc
    except OSError as exc:
        raise MinerUExtractionError("MineU OCR 无法启动，请检查安装环境。") from exc
    if completed.returncode != 0:
        details = _last_message(completed.stderr or completed.stdout)
        message = "MineU OCR 处理失败"
        if details:
            message += f"：{details}"
        raise MinerUExtractionError(message)


def _find_content_list(output_dir: Path) -> Path | None:
    candidates = sorted(output_dir.rglob("*_content_list.json"))
    return candidates[0] if candidates else None


def _abstract_regions(content_path: Path) -> set[tuple[int, tuple[int, int, int, int]]]:
    middle_files = sorted(content_path.parent.glob("*_middle.json"))
    if not middle_files:
        return set()
    try:
        payload = json.loads(middle_files[0].read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return set()

    regions: set[tuple[int, tuple[int, int, int, int]]] = set()
    for page in payload.get("pdf_info", []):
        width, height = page.get("page_size", [0, 0])[:2]
        if not width or not height:
            continue
        for block in page.get("para_blocks", []):
            if block.get("type") != "abstract" or len(block.get("bbox", [])) != 4:
                continue
            x0, y0, x1, y1 = block["bbox"]
            normalized = (
                int(x0 * 1000 / width),
                int(y0 * 1000 / height),
                int(x1 * 1000 / width),
                int(y1 * 1000 / height),
            )
            regions.add((_as_int(page.get("page_idx"), 0), normalized))
    return regions


def _matches_region(
    item: dict[str, Any],
    page_index: int,
    regions: set[tuple[int, tuple[int, int, int, int]]],
) -> bool:
    bbox = item.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return False
    candidate = tuple(_as_int(value, 0) for value in bbox)
    return any(
        region_page == page_index
        and all(abs(left - right) <= 2 for left, right in zip(candidate, region_bbox))
        for region_page, region_bbox in regions
    )


def _caption_text(item: dict[str, Any], *keys: str) -> str:
    values: list[str] = []
    for key in keys:
        raw = item.get(key, [])
        if isinstance(raw, list):
            values.extend(str(value).strip() for value in raw if str(value).strip())
        elif str(raw).strip():
            values.append(str(raw).strip())
    return " ".join(values)


def _is_reference_item(item: Any) -> bool:
    return bool(
        isinstance(item, dict)
        and item.get("type") == "list"
        and item.get("sub_type") == "ref_text"
    )


def _plain_html(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()


def _join_pages(pages: list[str]) -> tuple[str, tuple[int, ...]]:
    parts: list[str] = []
    offsets: list[int] = []
    cursor = 0
    for index, page in enumerate(pages):
        if index:
            parts.append("\n\f\n")
            cursor += 3
        offsets.append(cursor)
        parts.append(page)
        cursor += len(page)
    return "".join(parts), tuple(offsets)


def _last_message(output: str) -> str:
    lines = [re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line).strip() for line in output.splitlines()]
    useful = [line for line in lines if line and "Traceback" not in line]
    return useful[-1][:300] if useful else ""


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
