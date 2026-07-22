import argparse
import json
import sys
import tempfile
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def dependency_status():
    try:
        import fitz
        import paddle
        import paddleocr
    except Exception as error:
        emit({"available": False, "error": str(error)})
        return 1
    emit({
        "available": True,
        "paddle_version": getattr(paddle, "__version__", "unknown"),
        "paddleocr_version": getattr(paddleocr, "__version__", "unknown"),
        "pymupdf_version": getattr(fitz, "VersionBind", "unknown"),
    })
    return 0


def collect_text(value):
    if value is None:
        return []
    if hasattr(value, "json"):
        json_value = value.json
        value = json_value() if callable(json_value) else json_value
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return [value] if value.strip() else []
    if isinstance(value, dict):
        if isinstance(value.get("rec_texts"), list):
            return [str(text) for text in value["rec_texts"] if str(text).strip()]
        texts = []
        for child in value.values():
            texts.extend(collect_text(child))
        return texts
    if isinstance(value, (list, tuple)):
        if len(value) == 2 and isinstance(value[1], (list, tuple)) and value[1]:
            text = value[1][0]
            if isinstance(text, str):
                return [text] if text.strip() else []
        texts = []
        for child in value:
            texts.extend(collect_text(child))
        return texts
    return []


def create_engine(language, model):
    from paddleocr import PaddleOCR

    preset = {
        "PP-OCRv5_mobile": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
        "PP-OCRv5_server": ("PP-OCRv5_server_det", "PP-OCRv5_server_rec"),
    }.get(model)
    if preset:
        try:
            return PaddleOCR(
                lang=language,
                text_detection_model_name=preset[0],
                text_recognition_model_name=preset[1],
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=True,
            )
        except TypeError:
            pass
    try:
        return PaddleOCR(
            lang=language,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
        )
    except TypeError:
        return PaddleOCR(lang=language, use_angle_cls=True, show_log=False)


def recognize_page(engine, image_path):
    if hasattr(engine, "predict"):
        return collect_text(engine.predict(input=str(image_path)))
    return collect_text(engine.ocr(str(image_path), cls=True))


def run(args):
    import fitz

    engine = create_engine(args.language, args.model)
    document = fitz.open(args.input)
    if document.page_count == 0:
        raise RuntimeError("The PDF contains no pages")
    pages = []
    with tempfile.TemporaryDirectory(prefix="xdocuments-paddle-") as temp_dir:
        for index, page in enumerate(document):
            image_path = Path(temp_dir) / f"page-{index + 1}.png"
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(image_path)
            texts = recognize_page(engine, image_path)
            pages.append(f"## Page {index + 1}\n\n" + "\n".join(texts))
            emit({
                "type": "progress",
                "processed_pages": index + 1,
                "total_pages": document.page_count,
                "progress": (index + 1) * 100.0 / document.page_count,
            })
    markdown = "\n\n".join(pages)
    if not markdown.strip():
        raise RuntimeError("PaddleOCR did not recognize any text")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(markdown, encoding="utf-8")
    emit({"type": "complete", "characters": len(markdown)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--language", default="ch")
    parser.add_argument("--model", default="PP-OCRv5_mobile")
    args = parser.parse_args()
    if args.check:
        return dependency_status()
    if not args.input or not args.output:
        parser.error("--input and --output are required")
    try:
        run(args)
        return 0
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
