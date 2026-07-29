import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WHEELHOUSE_VERSION = 1;
const PYTHON_VERSION = "3.11";
const SOURCE_PACKAGE = "antlr4-python3-runtime==4.9.3";
const variants = {
  "win32-x64": {
    profile: "directml",
    platform: "win_amd64",
    requirements: "rapidocr-directml-requirements.txt",
    excludedPackage: "onnxruntime",
    abis: ["cp311", "abi3", "none"],
  },
  "darwin-arm64": {
    profile: "coreml",
    platform: "macosx_14_0_arm64",
    requirements: "rapidocr-coreml-requirements.txt",
    excludedPackage: "onnxruntime-directml",
    abis: ["cp311", "abi3", "none"],
  },
};

const variant = variants[`${process.platform}-${process.arch}`];
if (!variant) {
  console.log(`RapidOCR offline runtime is not packaged for ${process.platform}/${process.arch}.`);
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const constraintsPath = resolve(scriptDir, "rapidocr-constraints.txt");
const requirementsPath = resolve(scriptDir, variant.requirements);
const resourcesRoot = resolve(scriptDir, "..", "resources", "rapidocr-runtime");
const destination = join(resourcesRoot, variant.profile);
const requirementsSha256 = await sha256(requirementsPath);
const constraintsSha256 = await sha256(constraintsPath);

if (await wheelhouseIsReady(destination)) {
  console.log(`RapidOCR ${variant.profile} offline wheelhouse is already available.`);
  process.exit(0);
}

const python = await findPython();
if (!python) {
  throw new Error(
    "Python with pip is required to prepare the RapidOCR offline wheelhouse. " +
    "Set RAPIDOCR_PREPARE_PYTHON to a Python executable if it is not on PATH.",
  );
}

await mkdir(resourcesRoot, { recursive: true });
const staging = join(resourcesRoot, `.preparing-${variant.profile}-${process.pid}-${Date.now()}`);
const lockPath = join(staging, "locked-requirements.txt");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

try {
  const lockedRequirements = await selectedLockedRequirements();
  await writeFile(lockPath, `${lockedRequirements.join("\n")}\n`, "utf8");
  const indexes = unique([
    process.env.RAPIDOCR_PYPI_INDEX,
    process.env.PIP_INDEX_URL,
    "https://mirrors.ustc.edu.cn/pypi/simple",
    "https://pypi.org/simple",
  ].filter(Boolean));

  await runWithIndexes(indexes, (index) => [
    ...python.args,
    "-m", "pip", "download",
    "--disable-pip-version-check",
    "--no-input",
    "--prefer-binary",
    "--timeout", "90",
    "--retries", "2",
    "--no-deps",
    "--only-binary=:all:",
    "--dest", staging,
    "--requirement", lockPath,
    "--platform", variant.platform,
    "--python-version", "311",
    "--implementation", "cp",
    ...variant.abis.flatMap((abi) => ["--abi", abi]),
    "--index-url", index,
  ]);

  await runWithIndexes(indexes, (index) => [
    ...python.args,
    "-m", "pip", "wheel",
    "--disable-pip-version-check",
    "--no-input",
    "--no-deps",
    "--wheel-dir", staging,
    "--index-url", index,
    SOURCE_PACKAGE,
  ]);

  await rm(lockPath, { force: true });
  const files = (await readdir(staging)).filter((name) => name.endsWith(".whl")).sort();
  if (files.length !== lockedRequirements.length + 1) {
    throw new Error(
      `RapidOCR wheelhouse is incomplete: expected ${lockedRequirements.length + 1} wheels, got ${files.length}`,
    );
  }
  const manifest = {
    version: WHEELHOUSE_VERSION,
    profile: variant.profile,
    python_version: PYTHON_VERSION,
    requirements_sha256: requirementsSha256,
    constraints_sha256: constraintsSha256,
    files: await Promise.all(files.map(async (name) => {
      const path = join(staging, name);
      return { name, size: (await stat(path)).size, sha256: await sha256(path) };
    })),
  };
  await writeFile(
    join(staging, "wheelhouse-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  console.log(`RapidOCR ${variant.profile} offline wheelhouse is ready with ${files.length} wheels.`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

async function selectedLockedRequirements() {
  const lines = (await readFile(constraintsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.filter((line) => {
    const name = line.split(/[<=>!~\s]/, 1)[0].toLowerCase();
    return name !== variant.excludedPackage && name !== "antlr4-python3-runtime";
  });
}

async function wheelhouseIsReady(path) {
  try {
    const manifest = JSON.parse(await readFile(join(path, "wheelhouse-manifest.json"), "utf8"));
    if (
      manifest.version !== WHEELHOUSE_VERSION ||
      manifest.profile !== variant.profile ||
      manifest.python_version !== PYTHON_VERSION ||
      manifest.requirements_sha256 !== requirementsSha256 ||
      manifest.constraints_sha256 !== constraintsSha256 ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0
    ) {
      return false;
    }
    for (const file of manifest.files) {
      const wheelPath = join(path, file.name);
      if ((await stat(wheelPath)).size !== file.size || await sha256(wheelPath) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function findPython() {
  const candidates = [
    process.env.RAPIDOCR_PREPARE_PYTHON && { command: process.env.RAPIDOCR_PREPARE_PYTHON, args: [] },
    process.platform === "win32" && { command: "py", args: ["-3"] },
    { command: "python3", args: [] },
    { command: "python", args: [] },
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await commandSucceeds(candidate.command, [...candidate.args, "-m", "pip", "--version"])) {
      return candidate;
    }
  }
  return null;
}

async function runWithIndexes(indexes, argsForIndex) {
  let lastError;
  for (const index of indexes) {
    try {
      await run(python.command, argsForIndex(index));
      return;
    } catch (error) {
      lastError = error;
      console.warn(`RapidOCR wheel download through ${index} failed; trying the next index.`);
    }
  }
  throw lastError;
}

async function commandSucceeds(command, args) {
  try {
    await run(command, args, "ignore");
    return true;
  } catch {
    return false;
  }
}

function run(command, args, stdio = "inherit") {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio, windowsHide: true });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function unique(values) {
  return [...new Set(values)];
}
