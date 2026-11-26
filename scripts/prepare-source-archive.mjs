import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ENTRY = "scripts/source-native.mjs";
const GZIP_LEVEL = 9;
const SOURCE_ARCHIVE_MODES = Object.freeze(["full", "minimal"]);

// Minimal set of tracked files needed to boot offline desktop services when
// TeamHub binaries and the Native runtime are prebuilt. `apps/teamhub/go.mod`
// keeps the `apps/teamhub/` directory present as TeamHub's working directory.
export const SOURCE_SKELETON_FILES = Object.freeze([
  ".env.example",
  "apps/teamhub/go.mod",
  "package.json",
  "scripts/env-inventory.json",
  "scripts/local-defaults.env",
  "scripts/replace-process.mjs",
  "scripts/source-native.mjs",
  "scripts/with-local-env.mjs",
]);

/**
 * The desktop "Run on This Computer" flow unpacks this archive and runs the
 * services from it, so it holds committed files from one tree under a single
 * `<name>-<label>/` folder. `git archive` stamps entries with the commit time
 * and gzip runs without a header timestamp, so one commit always yields the
 * same digest.
 */
export function parseSourceArchiveArguments(arguments_) {
  const options = {
    label: null,
    mode: "full",
    name: "linger",
    output: path.join(repositoryRoot, ".linger-runtime/source-archive"),
    ref: "HEAD",
    "url-base": null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      ![
        "--label",
        "--mode",
        "--name",
        "--output",
        "--ref",
        "--url-base",
      ].includes(argument)
    ) {
      throw new Error(`Unknown source archive argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!SOURCE_ARCHIVE_MODES.includes(options.mode)) {
    throw new Error(`--mode must be full or minimal: ${options.mode}`);
  }
  for (const key of ["name", "label"]) {
    if (options[key] !== null && !/^[A-Za-z0-9][\w.-]*$/.test(options[key])) {
      throw new Error(`--${key} must be a plain file name: ${options[key]}`);
    }
  }
  const urlBase = options["url-base"];
  if (urlBase !== null && new URL(urlBase).protocol !== "https:") {
    throw new Error(`--url-base must be https: ${urlBase}`);
  }
  return {
    label: options.label,
    mode: options.mode,
    name: options.name,
    output: path.resolve(repositoryRoot, options.output),
    ref: options.ref,
    urlBase,
  };
}

/**
 * The commit a source ref names and the label its published files carry: a
 * tag names itself; any other ref gets the short commit.
 */
export async function resolveSourceRef(ref, label, cwd, mode = "full") {
  const commit = (
    await capture("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
    })
  ).trim();
  if (mode === "minimal") {
    const tracked = new Set(
      (
        await capture(
          "git",
          ["ls-tree", "--name-only", commit, "--", ...SOURCE_SKELETON_FILES],
          { cwd },
        )
      )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const missing = SOURCE_SKELETON_FILES.filter((file) => !tracked.has(file));
    if (missing.length > 0) {
      throw new Error(
        `${ref} is missing required minimal source files: ${missing.join(", ")}`,
      );
    }
  } else {
    const tracked = await capture(
      "git",
      ["ls-tree", "--name-only", commit, "--", SOURCE_ENTRY],
      { cwd },
    );
    if (tracked.trim() !== SOURCE_ENTRY) {
      throw new Error(`${ref} has no ${SOURCE_ENTRY}`);
    }
  }
  const isTag = await capture(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`],
    { cwd },
  ).then(
    () => true,
    () => false,
  );
  return {
    commit,
    label:
      label ??
      (/^[A-Za-z0-9][\w.-]*$/.test(ref) && isTag ? ref : commit.slice(0, 12)),
  };
}

export async function prepareSourceArchive(
  arguments_,
  { cwd = repositoryRoot } = {},
) {
  const options = parseSourceArchiveArguments(arguments_);
  const { commit, label } = await resolveSourceRef(
    options.ref,
    options.label,
    cwd,
    options.mode,
  );
  const folder = `${options.name}-${label}`;
  const fileName = `${folder}.tar.gz`;
  await mkdir(options.output, { recursive: true });
  const archive = path.join(options.output, fileName);
  const partial = `${archive}.partial`;

  const hash = createHash("sha256");
  let bytes = 0;
  const archiveArgs = [
    "archive",
    "--format=tar",
    `--prefix=${folder}/`,
    commit,
    ...(options.mode === "minimal" ? ["--", ...SOURCE_SKELETON_FILES] : []),
  ];
  const git = spawn("git", archiveArgs, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve, reject) => {
    git.once("error", reject);
    git.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git archive exited with ${code}`)),
    );
  });
  try {
    await pipeline(
      git.stdout,
      createGzip({ level: GZIP_LEVEL }),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(partial),
    );
    await exited;
    await rename(partial, archive);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const sha256 = hash.digest("hex");
  await writeFile(`${archive}.sha256`, `${sha256}  ${fileName}\n`);
  const result = {
    archive,
    bytes,
    commit,
    mode: options.mode,
    sha256,
    ...(options.urlBase && {
      url: new URL(fileName, options.urlBase.replace(/\/?$/, "/")).href,
    }),
  };
  await writeFile(
    path.join(options.output, "source-archive.json"),
    `${JSON.stringify({ ...result, archive: fileName }, null, 2)}\n`,
  );
  return result;
}

/** Reads the manifest for `LINGER_SOURCE_ARCHIVE_URL`/`_SHA256`. */
export async function sourceArchiveEnvironment(output) {
  const manifest = JSON.parse(
    await readFile(path.join(output, "source-archive.json"), "utf8"),
  );
  if (!manifest.url) throw new Error("source-archive.json has no url");
  return {
    LINGER_SOURCE_ARCHIVE_URL: manifest.url,
    LINGER_SOURCE_ARCHIVE_SHA256: manifest.sha256,
  };
}

export function capture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(`${command} ${args[0]} failed: ${stderr.trim() || code}`),
          ),
    );
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareSourceArchive(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    },
  );
}
