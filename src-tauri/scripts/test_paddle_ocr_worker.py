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
    def test_modern_engine_disables_mkldnn(self):
        calls = []

        def fake_engine(**kwargs):
            calls.append(kwargs)
            return kwargs

        module = SimpleNamespace(PaddleOCR=fake_engine)
        with patch.dict(sys.modules, {"paddleocr": module}):
            result = WORKER.create_engine("en", "PP-OCRv5_mobile")

        self.assertFalse(result["enable_mkldnn"])
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
            result = WORKER.create_engine("ch", "unknown")

        self.assertFalse(result["use_mkldnn"])
        self.assertEqual(result["lang"], "ch")
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
