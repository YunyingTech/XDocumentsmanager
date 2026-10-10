import json
import os
import sys
from pathlib import Path


def manifest_for(directory: Path, repository: str, tag: str) -> dict:
    version = tag.removeprefix("v")
    if not version or any(char not in "0123456789." for char in version) or version.endswith("."):
        raise ValueError(f"Invalid release tag: {tag}")

    platforms = {}
    patterns = {
        "windows-x86_64-nsis": "*.exe",
        "darwin-aarch64": "*.app.tar.gz",
    }
    for target, pattern in patterns.items():
        candidates = [p for p in directory.glob(pattern) if not p.name.endswith(".sig")]
        if len(candidates) != 1:
            raise ValueError(f"Expected one {pattern} updater bundle, found {len(candidates)}")
        bundle = candidates[0]
        signature_file = Path(f"{bundle}.sig")
        if not signature_file.is_file():
            raise ValueError(f"Missing updater signature: {signature_file.name}")
        signature = signature_file.read_text(encoding="utf-8").strip()
        if not signature:
            raise ValueError(f"Empty updater signature: {signature_file.name}")
        url = f"https://github.com/{repository}/releases/download/{tag}/{bundle.name}"
        platforms[target] = {"url": url, "signature": signature}

    result = {"version": version, "notes": f"XDocuments {tag}", "platforms": platforms}
    json.loads(json.dumps(result))
    return result


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: create_update_manifest.py <release-assets-directory>")
    target = Path(sys.argv[1]) / "latest.json"
    result = manifest_for(Path(sys.argv[1]), os.environ["GH_REPOSITORY"], os.environ["GH_TAG"])
    target.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Validated {len(result['platforms'])} signed updater targets for {result['version']}")


if __name__ == "__main__":
    main()
