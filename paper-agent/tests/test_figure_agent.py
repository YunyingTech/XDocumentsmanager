from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from agent.subagents.figure_agent import FigureAgent, FigureCritiqueError
from core.figure_store import FigureRecord


class RecordingModel:
    def __init__(self, *, reject_vision: bool = False, always_fail: bool = False) -> None:
        self.reject_vision = reject_vision
        self.always_fail = always_fail
        self.calls: list[object] = []

    def invoke(self, messages):
        self.calls.append(messages)
        if self.always_fail:
            raise RuntimeError("provider secret details")
        if self.reject_vision and isinstance(messages[0].content, list):
            raise RuntimeError("vision is unsupported")
        return AIMessage(content="### 图意解读\n该图展示方法流程。")


def _figure(tmp_path: Path) -> FigureRecord:
    image = tmp_path / "figure.jpg"
    image.write_bytes(b"jpeg")
    return FigureRecord(
        figure_id="figure-1",
        paper_id="paper-1",
        paper_title="Paper One",
        asset_path=str(image),
        page=3,
        section="Methods",
        kind="image",
        bbox=(0.0, 0.0, 1.0, 1.0),
        caption="Figure 1. Architecture.",
        context="The architecture has two retrieval stages.",
    )


def test_figure_agent_uses_pixels_and_text_when_model_supports_vision(
    tmp_path: Path,
) -> None:
    model = RecordingModel()
    result = FigureAgent(model).critique(_figure(tmp_path), focus="信息层级")

    assert result.evidence_mode == "pixels_and_text"
    assert "证据边界" in result.text
    content = model.calls[0][0].content
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert "MineU 图注" in content[0]["text"]
    assert "信息层级" in content[0]["text"]


def test_figure_agent_falls_back_to_caption_and_context(tmp_path: Path) -> None:
    model = RecordingModel(reject_vision=True)
    result = FigureAgent(model).critique(_figure(tmp_path))

    assert result.evidence_mode == "text_only"
    assert len(model.calls) == 2
    assert "未读取图片像素" in result.text
    assert "The architecture has two retrieval stages" in model.calls[1][0].content


def test_figure_agent_sanitizes_provider_errors(tmp_path: Path) -> None:
    with pytest.raises(FigureCritiqueError, match="检查模型服务") as error:
        FigureAgent(RecordingModel(always_fail=True)).critique(_figure(tmp_path))

    assert "secret details" not in str(error.value)
