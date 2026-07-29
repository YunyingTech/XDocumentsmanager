import importlib.util
import platform
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


WORKER_PATH = Path(__file__).with_name("rapid_ocr_worker.py")
SPEC = importlib.util.spec_from_file_location("rapid_ocr_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


def fake_component(provider):
    session = SimpleNamespace(get_providers=lambda: [provider, WORKER.CPU_PROVIDER])
    return SimpleNamespace(session=SimpleNamespace(session=session))


class ProviderSelectionTests(unittest.TestCase):
    def test_automatic_mode_prefers_directml_on_windows(self):
        with patch.object(platform, "system", return_value="Windows"):
            provider = WORKER.preferred_provider(
                "auto", [WORKER.DML_PROVIDER, WORKER.CPU_PROVIDER]
            )
        self.assertEqual(provider, WORKER.DML_PROVIDER)

    def test_cpu_mode_never_selects_an_accelerator(self):
        provider = WORKER.preferred_provider(
            "cpu", [WORKER.DML_PROVIDER, WORKER.CUDA_PROVIDER, WORKER.CPU_PROVIDER]
        )
        self.assertEqual(provider, WORKER.CPU_PROVIDER)

    def test_reads_the_actual_provider_from_all_three_sessions(self):
        engine = SimpleNamespace(
            text_det=fake_component(WORKER.DML_PROVIDER),
            text_cls=fake_component(WORKER.DML_PROVIDER),
            text_rec=fake_component(WORKER.DML_PROVIDER),
        )
        providers = WORKER.session_provider_lists(engine)
        self.assertEqual(WORKER.active_provider(providers), WORKER.DML_PROVIDER)

    def test_mixed_sessions_are_reported_as_cpu(self):
        providers = [
            [WORKER.DML_PROVIDER, WORKER.CPU_PROVIDER],
            [WORKER.CPU_PROVIDER],
            [WORKER.DML_PROVIDER, WORKER.CPU_PROVIDER],
        ]
        self.assertEqual(WORKER.active_provider(providers), WORKER.CPU_PROVIDER)


class EngineFallbackTests(unittest.TestCase):
    def test_auto_mode_rebuilds_on_cpu_when_directml_initialization_fails(self):
        calls = []

        def fake_engine(params):
            calls.append(params)
            if params["EngineConfig.onnxruntime.use_dml"]:
                raise RuntimeError("adapter unavailable")
            return SimpleNamespace(
                text_det=fake_component(WORKER.CPU_PROVIDER),
                text_cls=fake_component(WORKER.CPU_PROVIDER),
                text_rec=fake_component(WORKER.CPU_PROVIDER),
            )

        modules = {
            "onnxruntime": SimpleNamespace(
                get_available_providers=lambda: [
                    WORKER.DML_PROVIDER,
                    WORKER.CPU_PROVIDER,
                ]
            ),
            "rapidocr": SimpleNamespace(
                RapidOCR=fake_engine,
                ModelType=SimpleNamespace(SMALL="small"),
                OCRVersion=SimpleNamespace(PPOCRV6="PP-OCRv6"),
            ),
        }
        with patch.dict(sys.modules, modules), patch.object(
            platform, "system", return_value="Windows"
        ):
            _, status = WORKER.create_engine("ch", "PP-OCRv6_small", "auto")

        self.assertEqual(len(calls), 2)
        self.assertEqual(status["active_provider"], WORKER.CPU_PROVIDER)
        self.assertFalse(status["accelerated"])
        self.assertIn("adapter unavailable", status["fallback_reason"])


class OutputTests(unittest.TestCase):
    def test_uses_rapidocr_markdown_when_text_is_available(self):
        result = SimpleNamespace(txts=("hello",), to_markdown=lambda: "hello\n")
        self.assertEqual(WORKER.page_markdown(result), "hello")

    def test_empty_results_do_not_emit_placeholder_text(self):
        result = SimpleNamespace(txts=(), to_markdown=lambda: "placeholder")
        self.assertEqual(WORKER.page_markdown(result), "")


if __name__ == "__main__":
    unittest.main()
