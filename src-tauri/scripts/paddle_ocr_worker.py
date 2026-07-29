import argparse
import json
import sys
import tempfile
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def dependency_status(device):
    try:
        import fitz
        import paddle
        import paddleocr
    except Exception as error:
        emit({"available": False, "error": str(error)})
        return 1
    compiled_with_cuda = bool(paddle.is_compiled_with_cuda())
    cuda_device_count = 0
    gpu_name = None
    cuda_version = None
    cudnn_version = None
    if compiled_with_cuda:
        try:
            cuda_device_count = int(paddle.device.cuda.device_count())
        except Exception:
            cuda_device_count = 0
        try:
            cuda_version = paddle.version.cuda() or None
        except Exception:
            pass
        try:
            cudnn_version = paddle.version.cudnn() or None
        except Exception:
            pass
        if cuda_device_count:
            try:
                gpu_name = paddle.device.cuda.get_device_name(0)
            except Exception:
                pass

    requested_gpu = device.startswith("gpu")
    device_index = 0
    if requested_gpu and ":" in device:
        try:
            device_index = int(device.split(":", 1)[1])
        except ValueError:
            emit({"available": False, "error": f"Invalid PaddleOCR device: {device}"})
            return 1
    device_available = not requested_gpu or (
        compiled_with_cuda and 0 <= device_index < cuda_device_count
    )
    error = None
    if requested_gpu and not compiled_with_cuda:
        error = "This PaddlePaddle runtime was not built with CUDA support"
    elif requested_gpu and cuda_device_count == 0:
        error = "No NVIDIA CUDA device is available to PaddlePaddle; install a compatible NVIDIA driver"
    elif requested_gpu and device_index >= cuda_device_count:
        error = f"CUDA device {device_index} is unavailable; detected {cuda_device_count} device(s)"

    emit({
        "available": device_available,
        "paddle_version": getattr(paddle, "__version__", "unknown"),
        "paddleocr_version": getattr(paddleocr, "__version__", "unknown"),
        "pymupdf_version": getattr(fitz, "VersionBind", "unknown"),
        "requested_device": device,
        "active_device": device if device_available else None,
        "compiled_with_cuda": compiled_with_cuda,
        "cuda_device_count": cuda_device_count,
        "cuda_version": cuda_version,
        "cudnn_version": str(cudnn_version) if cudnn_version is not None else None,
        "gpu_name": gpu_name,
        "error": error,
    })
    return 0 if device_available else 1


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


def create_engine(language, model, device):
    from paddleocr import PaddleOCR

    runtime_options = {"device": device}
    if device == "cpu":
        # Some Windows CPU builds fail during PIR conversion with oneDNN.
        runtime_options["enable_mkldnn"] = False
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
                **runtime_options,
            )
        except (TypeError, ValueError):
            pass
    try:
        return PaddleOCR(
            lang=language,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
            **runtime_options,
        )
    except (TypeError, ValueError) as error:
        if device != "cpu":
            raise RuntimeError(
                f"Installed PaddleOCR does not accept CUDA device '{device}': {error}"
            ) from error
        return PaddleOCR(
            lang=language,
            use_angle_cls=True,
            show_log=False,
            use_mkldnn=False,
        )


def recognize_page(engine, image_path):
    if hasattr(engine, "predict"):
        return collect_text(engine.predict(input=str(image_path)))
    return collect_text(engine.ocr(str(image_path), cls=True))


def run(args):
    import fitz

    engine = create_engine(args.language, args.model, args.device)
    emit({"type": "runtime", "active_device": args.device})
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
    parser.add_argument("--device", choices=("cpu", "gpu:0"), default="cpu")
    args = parser.parse_args()
    if args.check:
        return dependency_status(args.device)
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
