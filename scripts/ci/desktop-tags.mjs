// Ordering and next-version rules for desktop-v<major>.<minor>.<patch>[-rc.<n>]
// tags. Other hyphenated suffixes are valid releases but never take part in
// ordering, so they are neither a comparison base nor a bump source.

const TAG_PATTERN = /^desktop-v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function parseDesktopTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}

function compareBase(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// A release candidate sorts before the stable version it leads up to.
export function compareDesktopTags(a, b) {
  const base = compareBase(a, b);
  if (base !== 0) return base;
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc - b.rc;
}

// The tag a release's notes are measured against: a stable release against the
// previous stable one, so its notes cover every release candidate in between;
// a release candidate against the closest earlier published release.
export function previousDesktopTag(publishedTags, tag) {
  const current = parseDesktopTag(tag);
  if (!current) return "";
  const earlier = publishedTags
    .map(parseDesktopTag)
    .filter(
      (candidate) => candidate && compareDesktopTags(candidate, current) < 0,
    )
    .filter((candidate) => current.rc !== null || candidate.rc === null)
    .sort(compareDesktopTags);
  return earlier.at(-1)?.tag ?? "";
}

// The version that releasing `kind` next would produce, from every desktop tag
// that exists. `rc` continues the release candidates ahead of the latest stable
// version, or starts rc.1 of its next patch version.
export function nextDesktopVersion(tags, kind) {
  const parsed = tags.map(parseDesktopTag).filter(Boolean);
  const stable = parsed
    .filter((tag) => tag.rc === null)
    .sort(compareDesktopTags)
    .at(-1);
  if (!stable) {
    throw new Error(
      "no stable desktop tag exists; release an explicit version",
    );
  }
  const { major, minor, patch } = stable;
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind !== "rc") throw new Error(`unknown release kind: ${kind}`);

  const pending = parsed
    .filter((tag) => tag.rc !== null && compareBase(tag, stable) > 0)
    .sort(compareDesktopTags)
    .at(-1);
  if (!pending) return `${major}.${minor}.${patch + 1}-rc.1`;
  return `${pending.major}.${pending.minor}.${pending.patch}-rc.${pending.rc + 1}`;
}

function main(args) {
  const [command, kind] = args;
  if (command !== "next" || !kind) {
    console.error(
      "Usage: desktop-tags.mjs next <rc|patch|minor|major>  (tags on stdin)",
    );
    process.exit(2);
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    try {
      console.log(nextDesktopVersion(input.split("\n").filter(Boolean), kind));
    } catch (error) {
      console.error(`desktop-tags: ${error.message}`);
      process.exit(1);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
