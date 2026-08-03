from pathlib import Path

from streamlit.testing.v1 import AppTest


def test_streamlit_app_starts_with_all_workspaces(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("EMBED_BACKEND", "hash")
    monkeypatch.setenv("CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setenv("CHECKPOINT_DB", str(tmp_path / "checkpoints.sqlite3"))
    monkeypatch.setenv("MEMORY_FILE", str(tmp_path / "memory.json"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    app_path = Path(__file__).resolve().parents[1] / "app.py"

    app = AppTest.from_file(str(app_path)).run(timeout=60)

    assert not app.exception
    assert [tab.label for tab in app.tabs] == [
        "论文入库",
        "阅读问答",
        "图片点评",
        "质量评估",
        "批量对比",
        "参考文献",
    ]
    assert [title.value for title in app.title] == ["论文阅读辅助 Agent"]
