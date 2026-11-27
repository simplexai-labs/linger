// Node 26 ESM module resolution hook for V2 decoupled app bundles.
//
// In V2 2+1 releases, business JS bundles live under:
//   <LINGER_HOME>/store/backend/<artifactId>/node-services/
// while shared production/native dependencies live in a content-addressed cache:
//   <LINGER_HOME>/infra/node-deps/<shortHash>/node_modules/
//
// Node.js's ESM resolver ignores NODE_PATH (unlike CommonJS require()). This
// lightweight `module.registerHooks()` loader redirects unresolved bare
// specifiers to `<LINGER_NODE_DEPS_DIR>/node_modules` and maps
// `@linger/voice-runtime` to `<LINGER_VOICE_RUNTIME_DIR>` with zero symlinks or
// Windows NTFS junctions.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const depsDir = process.env.LINGER_NODE_DEPS_DIR;
const fallbackDepsDir = process.env.LINGER_FALLBACK_NODE_DEPS_DIR;
const voiceRuntimeDir = process.env.LINGER_VOICE_RUNTIME_DIR;

const isBareSpecifier = (specifier) =>
  specifier.length > 0 &&
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("node:") &&
  !specifier.startsWith("file:") &&
  !specifier.startsWith("data:") &&
  !/^[A-Za-z]:[\\/]/.test(specifier);

const depsAnchorUrls = [];
const resolvedPrimaryDeps = depsDir ? path.resolve(depsDir) : undefined;
if (resolvedPrimaryDeps) {
  depsAnchorUrls.push(
    pathToFileURL(path.join(resolvedPrimaryDeps, "__linger_deps_anchor__.mjs"))
      .href,
  );
}
const resolvedFallbackDeps = fallbackDepsDir
  ? path.resolve(fallbackDepsDir)
  : undefined;
if (resolvedFallbackDeps && resolvedFallbackDeps !== resolvedPrimaryDeps) {
  depsAnchorUrls.push(
    pathToFileURL(
      path.join(resolvedFallbackDeps, "__linger_fallback_deps_anchor__.mjs"),
    ).href,
  );
}

if (depsAnchorUrls.length > 0 || voiceRuntimeDir) {
  const resolvedVoiceDir = voiceRuntimeDir
    ? path.resolve(voiceRuntimeDir)
    : undefined;

  const isModuleNotFound = (error) =>
    Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND",
    );

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        resolvedVoiceDir &&
        (specifier === "@linger/voice-runtime" ||
          specifier.startsWith("@linger/voice-runtime/"))
      ) {
        const subpath =
          specifier === "@linger/voice-runtime" ||
          specifier === "@linger/voice-runtime/worker"
            ? "dist/main.js"
            : specifier.slice("@linger/voice-runtime/".length);
        const candidate = path.join(resolvedVoiceDir, subpath);
        if (existsSync(candidate)) {
          return {
            url: pathToFileURL(candidate).href,
            shortCircuit: true,
          };
        }
      }

      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          depsAnchorUrls.length > 0 &&
          isBareSpecifier(specifier) &&
          isModuleNotFound(error)
        ) {
          let lastError = error;
          for (const anchorUrl of depsAnchorUrls) {
            if (context.parentURL === anchorUrl) continue;
            try {
              return nextResolve(specifier, {
                ...context,
                parentURL: anchorUrl,
              });
            } catch (candidateError) {
              if (!isModuleNotFound(candidateError)) {
                throw candidateError;
              }
              lastError = candidateError;
            }
          }
          throw lastError;
        }
        throw error;
      }
    },
  });
}
