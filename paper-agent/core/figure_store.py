"""Durable manifests for MineU-extracted paper figures."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
from typing import Any, Sequence

from core.pdf_loader import ImageRegion
from tools.structure import Section


@dataclass(frozen=True, slots=True)
class FigureRecord:
    figure_id: str
    paper_id: str
    paper_title: str
    asset_path: str
    page: int
    section: str
    kind: str
    bbox: tuple[float, float, float, float]
    caption: str
    context: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class FigureStore:
    """Store confirmed figure metadata separately from vector embeddings."""

    def __init__(self, directory: str | Path, *, asset_root: str | Path) -> None:
        self.directory = Path(directory).resolve()
        self.asset_root = Path(asset_root).resolve()

    def save_paper(
        self,
        paper_id: str,
        paper_title: str,
        images: Sequence[ImageRegion],
        sections: Sequence[Section],
        text: str,
    ) -> int:
        records: list[FigureRecord] = []
        for image in images:
            asset = self._validated_asset(image.asset_path)
            if asset is None:
                continue
            position = max(0, min(image.char_start or 0, len(text)))
            records.append(
                FigureRecord(
                    figure_id=image.image_id,
                    paper_id=paper_id,
                    paper_title=paper_title,
                    asset_path=str(asset),
                    page=max(1, image.page),
                    section=_section_for_image(sections, position, image.page),
                    kind=image.kind or "figure",
                    bbox=image.bbox,
                    caption=image.caption.strip(),
                    context=_nearby_context(text, position),
                )
            )

        manifest = self._manifest_path(paper_id)
        if not records:
            manifest.unlink(missing_ok=True)
            return 0
        self.directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "paper_id": paper_id,
            "paper_title": paper_title,
            "figures": [record.to_dict() for record in records],
        }
        temporary = manifest.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(manifest)
        return len(records)

    def list_for_paper(self, paper_id: str) -> list[FigureRecord]:
        path = self._manifest_path(paper_id)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return []
        if payload.get("paper_id") != paper_id or not isinstance(payload.get("figures"), list):
            return []

        records: list[FigureRecord] = []
        for raw in payload["figures"]:
            record = self._record_from_dict(raw, expected_paper_id=paper_id)
            if record is not None:
                records.append(record)
        return sorted(records, key=lambda item: (item.page, item.figure_id))

    def _record_from_dict(
        self, raw: Any, *, expected_paper_id: str
    ) -> FigureRecord | None:
        if not isinstance(raw, dict) or raw.get("paper_id") != expected_paper_id:
            return None
        asset = self._validated_asset(raw.get("asset_path"))
        bbox = raw.get("bbox")
        if asset is None or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            return None
        try:
            return FigureRecord(
                figure_id=str(raw["figure_id"]),
                paper_id=expected_paper_id,
                paper_title=str(raw.get("paper_title", expected_paper_id)),
                asset_path=str(asset),
                page=max(1, int(raw.get("page", 1))),
                section=str(raw.get("section", "Unknown")),
                kind=str(raw.get("kind", "figure")),
                bbox=tuple(float(value) for value in bbox),  # type: ignore[arg-type]
                caption=str(raw.get("caption", "")),
                context=str(raw.get("context", "")),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def _validated_asset(self, raw_path: Any) -> Path | None:
        if not raw_path:
            return None
        try:
            path = Path(str(raw_path)).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if (
            not path.is_file()
            or not path.is_relative_to(self.asset_root)
            or path.suffix.casefold() not in {".jpg", ".jpeg", ".png", ".webp"}
        ):
            return None
        return path

    def _manifest_path(self, paper_id: str) -> Path:
        safe_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", paper_id).strip("-.")
        return self.directory / f"{safe_id or 'paper'}.json"


def _section_for_image(
    sections: Sequence[Section], char_start: int, page: int
) -> str:
    preceding = [section for section in sections if section.char_start <= char_start]
    if preceding:
        return max(preceding, key=lambda section: section.char_start).title
    page_candidates = [section for section in sections if section.page <= page]
    if page_candidates:
        return max(page_candidates, key=lambda section: (section.page, section.char_start)).title
    return sections[0].title if sections else "Unknown"


def _nearby_context(text: str, char_start: int, radius: int = 900) -> str:
    start = max(0, char_start - radius)
    end = min(len(text), char_start + radius)
    context = text[start:end].strip()
    if start:
        context = "…" + context
    if end < len(text):
        context += "…"
    return context
