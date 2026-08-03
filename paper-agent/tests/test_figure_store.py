from __future__ import annotations

import json
from pathlib import Path

from core.figure_store import FigureStore
from core.pdf_loader import ImageRegion
from tools.structure import Section


def test_figure_manifest_preserves_evidence_and_rejects_outside_paths(
    tmp_path: Path,
) -> None:
    asset_root = tmp_path / "runtime" / "mineru"
    asset = asset_root / "paper" / "ocr" / "images" / "figure.jpg"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"image")
    store = FigureStore(tmp_path / "runtime" / "figures", asset_root=asset_root)
    text = "Introduction\nMotivation.\n\nMethods\nMethod context around the figure."
    sections = [
        Section("Introduction", 1, 0, 1, "introduction"),
        Section("Methods", 1, text.index("Methods"), 2, "methods"),
    ]
    image = ImageRegion(
        "mineru-p2-image-1",
        2,
        (1.0, 2.0, 30.0, 40.0),
        asset_path=str(asset),
        caption="Figure 1. Method overview.",
        kind="image",
        char_start=text.index("Method context"),
    )

    assert store.save_paper("paper-1", "Paper One", [image], sections, text) == 1
    records = store.list_for_paper("paper-1")

    assert len(records) == 1
    assert records[0].section == "Methods"
    assert records[0].caption == "Figure 1. Method overview."
    assert "Method context" in records[0].context

    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"secret")
    manifest = tmp_path / "runtime" / "figures" / "paper-1.json"
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["figures"][0]["asset_path"] = str(outside)
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    assert store.list_for_paper("paper-1") == []
