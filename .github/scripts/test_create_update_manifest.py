import tempfile
import unittest
from pathlib import Path

from create_update_manifest import manifest_for


class ReleaseManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.assets = Path(self.temp.name)
        for name in ("XDocuments_0.1.11_x64-setup.exe", "XDocuments_aarch64.app.tar.gz"):
            (self.assets / name).write_bytes(b"signed bundle")
            (self.assets / f"{name}.sig").write_text("base64-minisign-signature\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_creates_platform_urls_with_signature_contents(self):
        result = manifest_for(self.assets, "YunyingTech/XDocumentsmanager", "v0.1.11")
        self.assertEqual(result["version"], "0.1.11")
        self.assertEqual(result["platforms"]["windows-x86_64-nsis"]["signature"], "base64-minisign-signature")
        self.assertIn("releases/download/v0.1.11/", result["platforms"]["darwin-aarch64"]["url"])

    def test_rejects_missing_or_ambiguous_bundles(self):
        (self.assets / "XDocuments_0.1.11_x64-setup.exe.sig").unlink()
        with self.assertRaisesRegex(ValueError, "Missing updater signature"):
            manifest_for(self.assets, "YunyingTech/XDocumentsmanager", "v0.1.11")
        (self.assets / "XDocuments_0.1.11_x64-setup.exe.sig").write_text("sig", encoding="utf-8")
        (self.assets / "duplicate.exe").write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "Expected one"):
            manifest_for(self.assets, "YunyingTech/XDocumentsmanager", "v0.1.11")


if __name__ == "__main__":
    unittest.main()
