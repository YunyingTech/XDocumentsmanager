import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const pythonVariants = {
  "win32-x64": {
    fileName: "python-3.11.9-embed-amd64.zip",
    sha256: "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b",
    urls: [
      "https://npmmirror.com/mirrors/python/3.11.9/python-3.11.9-embed-amd64.zip",
      "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
    ],
  },
  "darwin-arm64": {
    fileName: "cpython-3.11.12+20250517-aarch64-apple-darwin-install_only_stripped.tar.gz",
    sha256: "82ffd1ecf04d447580b40d5c5abb5bf12c6838b009e1e75e92dae05debfc9986",
    urls: [
      "https://github.com/astral-sh/python-build-standalone/releases/download/20250517/cpython-3.11.12%2B20250517-aarch64-apple-darwin-install_only_stripped.tar.gz",
    ],
  },
};

const pip = {
  fileName: "pip-25.1.1-py3-none-any.whl",
  sha256: "2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af",
  urls: [
    "https://files.pythonhosted.org/packages/29/a2/d40fb2460e883eca5199c62cfc2463fd261f760556ae6290f88488c362c0/pip-25.1.1-py3-none-any.whl",
  ],
};

const setuptools = {
  fileName: "setuptools-80.9.0-py3-none-any.whl",
  sha256: "062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922",
  urls: [
    "https://files.pythonhosted.org/packages/a3/dc/17031897dae0efacfea57dfd3a82fdd2a2aeb58e0ff71b77b87e44edc772/setuptools-80.9.0-py3-none-any.whl",
  ],
};

const wheel = {
  fileName: "wheel-0.45.1-py3-none-any.whl",
  sha256: "708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248",
  urls: [
    "https://files.pythonhosted.org/packages/0b/2c/87f3254fd8ffd29e4c02732eee68a83a1d3c346ae39bc6822dcbcb697f2b/wheel-0.45.1-py3-none-any.whl",
  ],
};

const variant = pythonVariants[`${process.platform}-${process.arch}`];
if (!variant) {
  console.log(`PaddleOCR managed runtime is not packaged for ${process.platform}/${process.arch}.`);
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const resourcesDir = resolve(scriptDir, "..", "resources", "paddle-runtime");
await mkdir(resourcesDir, { recursive: true });

await ensureAsset(variant);
await ensureAsset(pip);
await ensureAsset(setuptools);
await ensureAsset(wheel);
console.log(`PaddleOCR bootstrap runtime is ready for ${process.platform}/${process.arch}.`);

async function ensureAsset(asset) {
  const destination = join(resourcesDir, asset.fileName);
  if (await isFile(destination) && await sha256(destination) === asset.sha256) {
    console.log(`${asset.fileName} is already available.`);
    return;
  }

  const partial = `${destination}.part`;
  await rm(partial, { force: true });
  let lastError;
  for (const url of asset.urls) {
    try {
      console.log(`Downloading ${url}`);
      await downloadWithRetry(url, partial);
      const actual = await sha256(partial);
      if (actual !== asset.sha256) {
        throw new Error(`Checksum mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${actual}`);
      }
      await rm(destination, { force: true });
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
    }
  }
  throw new Error(`Could not prepare ${asset.fileName}: ${lastError}`);
}

async function downloadWithRetry(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(destination, { force: true });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(attempt * 2_000);
    }
  }
  throw lastError;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
