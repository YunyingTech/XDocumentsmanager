import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const version = "8.17.0";
const platformNames = {
  win32: "windows",
  darwin: "darwin",
};
const architectureNames = {
  x64: "x86_64",
  arm64: "aarch64",
};

const platform = platformNames[process.platform];
const architecture = architectureNames[process.arch];
if (!platform || !architecture) {
  throw new Error(
    `Elasticsearch packaging is not configured for ${process.platform}/${process.arch}`,
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const resourcesDir = resolve(scriptDir, "..", "resources");
const distributionDir = join(resourcesDir, "elasticsearch");
const runtimeDir = join(distributionDir, "runtime");
const launcherName = process.platform === "win32" ? "elasticsearch.bat" : "elasticsearch";
const launcherPath = join(runtimeDir, "bin", launcherName);

if (await isFile(launcherPath)) {
  console.log(
    `Elasticsearch ${version} runtime is already available for ${platform}/${architecture}.`,
  );
  process.exit(0);
}

const extension = process.platform === "win32" ? "zip" : "tar.gz";
const archiveName = `elasticsearch-${version}-${platform}-${architecture}.${extension}`;
const archivePath = join(resourcesDir, archiveName);
const extractDir = join(resourcesDir, ".elasticsearch-extract");
const downloadUrl = `https://artifacts.elastic.co/downloads/elasticsearch/${archiveName}`;

await mkdir(resourcesDir, { recursive: true });
await mkdir(distributionDir, { recursive: true });

try {
  console.log(`Downloading ${downloadUrl}`);
  const expectedChecksum = (await fetchTextWithRetry(`${downloadUrl}.sha512`))
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  await downloadWithRetry(downloadUrl, archivePath);

  const actualChecksum = await sha512(archivePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Elasticsearch archive checksum mismatch. Expected ${expectedChecksum}, got ${actualChecksum}.`,
    );
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  const extracted = spawnSync("tar", ["-xf", archivePath, "-C", extractDir], {
    stdio: "inherit",
  });
  if (extracted.status !== 0) {
    throw new Error(`Could not extract ${archiveName} with tar (exit code ${extracted.status}).`);
  }

  const entries = await readdir(extractDir, { withFileTypes: true });
  let expandedDir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractDir, entry.name);
    if (await isFile(join(candidate, "bin", launcherName))) {
      expandedDir = candidate;
      break;
    }
  }
  if (!expandedDir) {
    throw new Error(
      `Downloaded archive does not contain a valid ${platform} Elasticsearch distribution.`,
    );
  }

  await rm(runtimeDir, { recursive: true, force: true });
  await rename(expandedDir, runtimeDir);
  if (process.platform !== "win32") {
    await chmod(launcherPath, 0o755);
  }
  console.log(`Elasticsearch ${version} runtime prepared at ${distributionDir}`);
} finally {
  await rm(archivePath, { force: true });
  await rm(extractDir, { recursive: true, force: true });
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(2 * 60 * 60 * 1000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(attempt * 3000);
      }
    }
  }
  throw new Error(`Failed to download ${url}: ${lastError}`);
}

async function fetchTextWithRetry(url) {
  return (await fetchWithRetry(url)).text();
}

async function downloadWithRetry(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(destination, { force: true });
    try {
      const response = await fetchWithRetry(url, 1);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await delay(attempt * 3000);
      }
    }
  }
  throw lastError;
}

async function sha512(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
