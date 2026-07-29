import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


WORKER_PATH = Path(__file__).with_name("paddle_ocr_worker.py")
SPEC = importlib.util.spec_from_file_location("paddle_ocr_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class PaddleEngineTests(unittest.TestCase):
    def test_modern_cpu_engine_selects_cpu_and_disables_mkldnn(self):
        calls = []

        def fake_engine(**kwargs):
            calls.append(kwargs)
            return kwargs

        module = SimpleNamespace(PaddleOCR=fake_engine)
        with patch.dict(sys.modules, {"paddleocr": module}):
            result = WORKER.create_engine("en", "PP-OCRv5_mobile", "cpu")

        self.assertFalse(result["enable_mkldnn"])
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["text_detection_model_name"], "PP-OCRv5_mobile_det")
        self.assertEqual(len(calls), 1)

    def test_legacy_fallback_disables_mkldnn(self):
        calls = []

        def fake_engine(**kwargs):
            calls.append(kwargs)
            if "enable_mkldnn" in kwargs:
                raise TypeError("legacy API")
            return kwargs

        module = SimpleNamespace(PaddleOCR=fake_engine)
        with patch.dict(sys.modules, {"paddleocr": module}):
            result = WORKER.create_engine("ch", "unknown", "cpu")

        self.assertFalse(result["use_mkldnn"])
        self.assertEqual(result["lang"], "ch")
        self.assertEqual(len(calls), 2)

    def test_modern_gpu_engine_selects_cuda_without_cpu_options(self):
        calls = []

        def fake_engine(**kwargs):
            calls.append(kwargs)
            return kwargs

        module = SimpleNamespace(PaddleOCR=fake_engine)
        with patch.dict(sys.modules, {"paddleocr": module}):
            result = WORKER.create_engine("en", "PP-OCRv5_mobile", "gpu:0")

        self.assertEqual(result["device"], "gpu:0")
        self.assertNotIn("enable_mkldnn", result)
        self.assertEqual(len(calls), 1)

    def test_gpu_engine_never_silently_falls_back_to_cpu(self):
        def fake_engine(**kwargs):
            raise ValueError("Unknown argument: device")

        module = SimpleNamespace(PaddleOCR=fake_engine)
        with patch.dict(sys.modules, {"paddleocr": module}):
            with self.assertRaisesRegex(RuntimeError, "does not accept CUDA"):
                WORKER.create_engine("en", "unknown", "gpu:0")


class DependencyStatusTests(unittest.TestCase):
    def test_reports_a_usable_cuda_12_device(self):
        payloads = []
        cuda = SimpleNamespace(
            device_count=lambda: 1,
            get_device_name=lambda index: "NVIDIA RTX 4070",
        )
        paddle = SimpleNamespace(
            __version__="3.3.1",
            is_compiled_with_cuda=lambda: True,
            device=SimpleNamespace(cuda=cuda),
            version=SimpleNamespace(cuda=lambda: "12.6", cudnn=lambda: "9.5.1"),
        )
        modules = {
            "fitz": SimpleNamespace(VersionBind="1.24.14"),
            "paddle": paddle,
            "paddleocr": SimpleNamespace(__version__="3.3.1"),
        }
        with patch.dict(sys.modules, modules), patch.object(WORKER, "emit", payloads.append):
            result = WORKER.dependency_status("gpu:0")

        self.assertEqual(result, 0)
        self.assertTrue(payloads[0]["available"])
        self.assertTrue(payloads[0]["compiled_with_cuda"])
        self.assertEqual(payloads[0]["cuda_version"], "12.6")
        self.assertEqual(payloads[0]["gpu_name"], "NVIDIA RTX 4070")

    def test_rejects_gpu_mode_for_a_cpu_paddle_build(self):
        payloads = []
        paddle = SimpleNamespace(
            __version__="3.3.1",
            is_compiled_with_cuda=lambda: False,
        )
        modules = {
            "fitz": SimpleNamespace(VersionBind="1.24.14"),
            "paddle": paddle,
            "paddleocr": SimpleNamespace(__version__="3.3.1"),
        }
        with patch.dict(sys.modules, modules), patch.object(WORKER, "emit", payloads.append):
            result = WORKER.dependency_status("gpu:0")

        self.assertEqual(result, 1)
        self.assertFalse(payloads[0]["available"])
        self.assertIn("not built with CUDA", payloads[0]["error"])


if __name__ == "__main__":
    unittest.main()
