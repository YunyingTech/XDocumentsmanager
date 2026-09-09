import argparse
import json
import platform
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path


CPU_PROVIDER = "CPUExecutionProvider"
CUDA_PROVIDER = "CUDAExecutionProvider"
DML_PROVIDER = "DmlExecutionProvider"
COREML_PROVIDER = "CoreMLExecutionProvider"


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def preferred_provider(device_mode, available_providers):
    if device_mode == "cpu":
        return CPU_PROVIDER

    system = platform.system()
    candidates = []
    if system == "Windows":
        candidates.append(DML_PROVIDER)
    elif system == "Darwin":
        candidates.append(COREML_PROVIDER)
    candidates.append(CUDA_PROVIDER)
    for provider in candidates:
        if provider in available_providers:
            return provider
    return CPU_PROVIDER


def engine_parameters(language, model, provider):
    from rapidocr import ModelType, OCRVersion

    model_type = ModelType.SMALL if model == "PP-OCRv6_small" else ModelType.SMALL
    return {
        "Global.log_level": "error",
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Det.lang_type": language,
        "Det.model_type": model_type,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
        "Rec.lang_type": language,
        "Rec.model_type": model_type,
        "EngineConfig.onnxruntime.use_cuda": provider == CUDA_PROVIDER,
        "EngineConfig.onnxruntime.use_dml": provider == DML_PROVIDER,
        "EngineConfig.onnxruntime.use_coreml": provider == COREML_PROVIDER,
    }


def session_provider_lists(engine):
    providers = []
    for component_name in ("text_det", "text_cls", "text_rec"):
        component = getattr(engine, component_name)
        inference = getattr(component, "session")
        session = getattr(inference, "session", inference)
        providers.append(list(session.get_providers()))
    return providers


def active_provider(provider_lists):
    first = [providers[0] for providers in provider_lists if providers]
    if len(first) == len(provider_lists) and first and len(set(first)) == 1:
        return first[0]
    return CPU_PROVIDER


def create_engine(language, model, device_mode):
    import onnxruntime
    from rapidocr import RapidOCR

    available = list(onnxruntime.get_available_providers())
    requested = preferred_provider(device_mode, available)
    fallback_reason = None
    try:
        engine = RapidOCR(params=engine_parameters(language, model, requested))
    except Exception as error:
        if device_mode != "auto" or requested == CPU_PROVIDER:
            raise
        fallback_reason = f"{requested} initialization failed; using CPU: {error}"
        engine = RapidOCR(params=engine_parameters(language, model, CPU_PROVIDER))

    provider_lists = session_provider_lists(engine)
    active = active_provider(provider_lists)
    if (
        device_mode == "auto"
        and requested != CPU_PROVIDER
        and active != requested
        and fallback_reason is None
    ):
        fallback_reason = (
            f"{requested} was available but the OCR sessions selected {active}; using CPU."
        )
    elif device_mode == "auto" and requested == CPU_PROVIDER:
        fallback_reason = "No supported GPU execution provider is available; using CPU."

    return engine, {
        "requested_provider": requested,
        "active_provider": active,
        "accelerated": active != CPU_PROVIDER,
        "available_providers": available,
        "session_providers": provider_lists,
        "fallback_reason": fallback_reason,
    }


def dependency_status(device_mode, language="ch", model="PP-OCRv6_small"):
    try:
        import fitz
        import onnxruntime

        _, provider_status = create_engine(language, model, device_mode)
        emit(
            {
                "available": True,
                "rapidocr_version": version("rapidocr"),
                "onnxruntime_version": onnxruntime.__version__,
                "pymupdf_version": fitz.VersionBind,
                "requested_device_mode": device_mode,
                **provider_status,
                "error": None,
            }
        )
        return 0
    except Exception as error:
        emit(
            {
                "available": False,
                "requested_device_mode": device_mode,
                "active_provider": None,
                "accelerated": False,
                "available_providers": [],
                "session_providers": [],
                "fallback_reason": None,
                "error": str(error),
            }
        )
        return 1


def page_markdown(result):
    texts = getattr(result, "txts", None)
    if not texts:
        return ""
    to_markdown = getattr(result, "to_markdown", None)
    if callable(to_markdown):
        return str(to_markdown()).strip()
    return "\n".join(str(text) for text in texts if str(text).strip())


def cached_engine(cache, language, model, device_mode):
    key = (language, model, device_mode)
    if key not in cache:
        cache[key] = create_engine(language, model, device_mode)
    return cache[key]


def process_document(input_path, output_path, engine, task_id=None):
    import fitz

    document = fitz.open(input_path)
    if document.page_count == 0:
        raise RuntimeError("The PDF contains no pages")

    pages = []
    with tempfile.TemporaryDirectory(prefix="xdocuments-rapidocr-") as temp_dir:
        for index, page in enumerate(document):
            image_path = Path(temp_dir) / f"page-{index + 1}.png"
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(image_path)
            markdown = page_markdown(engine(image_path))
            pages.append(f"## Page {index + 1}\n\n{markdown}".rstrip())
            progress = {
                "type": "progress",
                "processed_pages": index + 1,
                "total_pages": document.page_count,
                "progress": (index + 1) * 100.0 / document.page_count,
            }
            if task_id is not None:
                progress["task_id"] = task_id
            emit(progress)

    markdown = "\n\n".join(pages)
    if not any(page.partition("\n\n")[2].strip() for page in pages):
        raise RuntimeError("RapidOCR did not recognize any text")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(markdown, encoding="utf-8")
    return len(markdown)


def run(args):
    engine, provider_status = create_engine(args.language, args.model, args.device)
    emit({"type": "runtime", **provider_status})
    characters = process_document(args.input, args.output, engine)
    emit({"type": "complete", "characters": characters})


def run_server():
    engines = {}
    for line in sys.stdin:
        if not line.strip():
            continue
        task_id = None
        try:
            job = json.loads(line)
            task_id = str(job["task_id"])
            language = str(job.get("language", "ch"))
            model = str(job.get("model", "PP-OCRv6_small"))
            device = str(job.get("device", "auto"))
            engine, provider_status = cached_engine(engines, language, model, device)
            emit({"type": "runtime", "task_id": task_id, **provider_status})
            characters = process_document(
                str(job["input"]), str(job["output"]), engine, task_id
            )
            emit({"type": "complete", "task_id": task_id, "characters": characters})
        except Exception as error:
            emit({"type": "error", "task_id": task_id, "error": str(error)})
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--language", default="ch")
    parser.add_argument("--model", choices=("PP-OCRv6_small",), default="PP-OCRv6_small")
    parser.add_argument("--device", choices=("auto", "cpu"), default="auto")
    args = parser.parse_args()
    if args.server:
        return run_server()
    if args.check:
        return dependency_status(args.device, args.language, args.model)
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
