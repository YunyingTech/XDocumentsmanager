"""Evidence-bounded commentary for MineU-extracted paper figures."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import mimetypes
from pathlib import Path
from typing import Any, Literal

from langchain_core.messages import AIMessage, HumanMessage

from core.figure_store import FigureRecord


FIGURE_SYSTEM_PROMPT = """你是论文图片点评子 Agent。只能依据输入图片、MineU 图注、所属章节和相邻正文进行分析，不得补造论文结论。使用以下小节输出：图意解读、表达优点、潜在问题、改进建议、证据边界。证据不足时必须明确指出。"""


class FigureCritiqueError(RuntimeError):
    """A user-facing figure analysis failure."""


@dataclass(frozen=True, slots=True)
class FigureCritique:
    text: str
    evidence_mode: Literal["pixels_and_text", "text_only"]


class FigureAgent:
    """Use image pixels when supported and fall back to extracted text evidence."""

    def __init__(self, model: Any) -> None:
        self.model = model

    def critique(self, figure: FigureRecord, *, focus: str = "") -> FigureCritique:
        prompt = _critique_prompt(figure, focus=focus)
        try:
            image_url = _image_data_url(Path(figure.asset_path))
            response = self.model.invoke(
                [
                    HumanMessage(
                        content=[
                            {"type": "text", "text": FIGURE_SYSTEM_PROMPT + "\n\n" + prompt},
                            {"type": "image_url", "image_url": {"url": image_url}},
                        ]
                    )
                ]
            )
            text = _response_text(response)
            if not text:
                raise ValueError("empty vision response")
            return FigureCritique(
                _with_evidence_boundary(text, "pixels_and_text"), "pixels_and_text"
            )
        except Exception:
            # OpenAI-compatible providers differ in vision support. Retry without pixels.
            try:
                response = self.model.invoke(
                    [
                        HumanMessage(
                            content=(
                                FIGURE_SYSTEM_PROMPT
                                + "\n\n当前模型不支持或未能读取图片像素，只能依据文本证据点评。\n\n"
                                + prompt
                            )
                        )
                    ]
                )
                text = _response_text(response)
                if not text:
                    raise ValueError("empty text response")
                return FigureCritique(
                    _with_evidence_boundary(text, "text_only"), "text_only"
                )
            except Exception as exc:
                raise FigureCritiqueError(
                    "图片点评失败，请检查模型服务配置后重试。"
                ) from exc


def _critique_prompt(figure: FigureRecord, *, focus: str) -> str:
    return (
        f"论文：{figure.paper_title}\n"
        f"页码：{figure.page}\n"
        f"章节：{figure.section}\n"
        f"类型：{figure.kind}\n"
        f"MineU 图注：{figure.caption or '未提取到图注'}\n"
        f"用户关注点：{focus.strip() or '整体表达与论证质量'}\n\n"
        f"相邻正文：\n{figure.context or '未提取到相邻正文'}"
    )


def _image_data_url(path: Path) -> str:
    if not path.is_file():
        raise OSError("image asset is unavailable")
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _response_text(response: Any) -> str:
    content = response.content if isinstance(response, AIMessage) else getattr(response, "content", response)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(
            str(item.get("text", "")).strip()
            for item in content
            if isinstance(item, dict) and str(item.get("text", "")).strip()
        )
    return str(content or "").strip()


def _with_evidence_boundary(
    text: str, mode: Literal["pixels_and_text", "text_only"]
) -> str:
    boundary = (
        "本次点评结合了图片像素、MineU 图注、章节和相邻正文。"
        if mode == "pixels_and_text"
        else "当前模型未读取图片像素，本次点评仅依据 MineU 图注、章节和相邻正文。"
    )
    if "证据边界" in text:
        return f"{text.rstrip()}\n\n**证据模式**：{boundary}"
    return f"{text.rstrip()}\n\n### 证据边界\n{boundary}"
