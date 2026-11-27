"""Checks of what build.mjs bundles for Native in dist/installer/native/.

With a bundled source package, the TeamHub binaries (teamhub-<target>/) and
the services with Node.js (runtime-<target>/) built from it must be there and
match their manifests and that package; scripts/build-teamhub.mjs and
scripts/build-native-runtime.mjs write them. Every package script runs these
before staging the app.
"""
import json
import os
import sys

from archive import sha256

DESKTOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE = os.path.join(DESKTOP, "dist", "installer", "native")
COMPUTER_TOOLS = os.path.join(DESKTOP, "dist", "computer-tools")
SOURCE = os.path.join(DESKTOP, "dist", "installer", "source")
SEED = os.path.join(DESKTOP, "dist", "seed")
TEAMHUB_COMMANDS = ("teamhub", "migrate", "account")
V2_SEED_MODULES = ("web", "backend", "node-native-deps")


def check_seed_manifest(target, seed_dir=SEED):
    """Validates a V2 offline seed folder (`dist/seed/seed-manifest.json`).

    V2 shells ship prebuilt modular bundles instead of a 45 MB source archive,
    so every referenced archive is verified directly by size and sha256 without
    requiring `sourceArchiveSha256`.
    """
    manifest_path = os.path.join(seed_dir, "seed-manifest.json")
    if not os.path.exists(manifest_path):
        return None
    with open(manifest_path) as file:
        manifest = json.load(file)
    if manifest.get("schema") != 1:
        sys.exit(f"{manifest_path}: unsupported seed manifest schema {manifest.get('schema')}")
    if manifest.get("target") != target:
        sys.exit(f"{manifest_path}: seed target is {manifest.get('target')}, expected {target}")
    bundles = manifest.get("bundles")
    if not isinstance(bundles, dict):
        sys.exit(f"{manifest_path}: missing bundles map")
    for name in V2_SEED_MODULES:
        item = bundles.get(name)
        if not isinstance(item, dict) or not item.get("file"):
            sys.exit(f"{manifest_path}: missing required seed bundle '{name}'")
        rel = item["file"]
        if rel.startswith("/") or ".." in rel.split("/"):
            sys.exit(f"{manifest_path}: unsafe bundle path '{rel}'")
        full = os.path.join(seed_dir, rel)
        if not matches(full, item):
            sys.exit(f"{full} does not match {manifest_path} for '{name}'")
    return manifest
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"}


def _is_macho(path):
    with open(path, "rb") as source:
        return source.read(4) in MACHO_MAGIC


def matches(path, item):
    return os.path.isfile(path) and os.path.getsize(path) == item["bytes"] and sha256(path) == item["sha256"]


def _manifest(directory, target, what):
    """The manifest in directory, checked against target and the bundled source."""
    path = os.path.join(directory, "manifest.json")
    if not os.path.exists(path):
        if os.path.isdir(SOURCE):
            sys.exit(f"dist/ bundles a source package but no {what} for {target}; "
                     "run build.mjs with LINGER_SOURCE_ARCHIVE_FILE again")
        return None
    with open(path) as file:
        manifest = json.load(file)
    if manifest.get("target") != target:
        sys.exit(f"{path} is for {manifest.get('target')}")
    archives = os.listdir(SOURCE) if os.path.isdir(SOURCE) else []
    if archives and manifest.get("sourceArchiveSha256") != sha256(os.path.join(SOURCE, archives[0])):
        sys.exit(f"{path} was built from another source package than {archives[0]}")
    return manifest


def check_teamhub(target, native=NATIVE):
    """Exits unless the TeamHub binaries match their manifest and the bundled source."""
    directory = os.path.join(native, f"teamhub-{target}")
    manifest = _manifest(directory, target, "TeamHub binaries")
    if manifest is None:
        return
    for command in TEAMHUB_COMMANDS:
        binary = manifest["binaries"][command]
        if not matches(os.path.join(directory, binary["file"]), binary):
            sys.exit(f"{directory}/{binary['file']} does not match its manifest")


def _shared_node_parts(node, manifest_path):
    binary = node.get("binary")
    parts = binary.split("/") if isinstance(binary, str) else []
    if (
        not isinstance(binary, str)
        or not binary
        or "\\" in binary
        or os.path.isabs(binary)
        or any(part in ("", ".", "..") for part in parts)
    ):
        sys.exit(f"{manifest_path} has an invalid shared node binary path")
    return parts


def check_runtime(target, native=NATIVE, computer_tools_dir=None):
    """Exits unless the bundled services and Node.js match their manifest and
    the bundled source; in the folder layout, every file of the services too."""
    directory = os.path.join(native, f"runtime-{target}")
    manifest = _manifest(directory, target, "Native runtime")
    if manifest is None:
        return
    folder = manifest.get("layout") == "directory"
    items = [manifest["directory" if folder else "archive"]]
    node = manifest["node"]
    if node.get("shared"):
        parts = _shared_node_parts(node, os.path.join(directory, "manifest.json"))
        tools_root = (
            computer_tools_dir
            if computer_tools_dir is not None
            else os.path.join(COMPUTER_TOOLS, target)
        )
        node_file = os.path.join(tools_root, *parts)
        if not matches(node_file, node):
            sys.exit(f"{node_file} does not match {directory}/manifest.json")
    else:
        items.append(node)
    if folder:
        runtime = os.path.dirname(manifest["directory"]["file"])
        with open(os.path.join(directory, manifest["directory"]["file"])) as file:
            files = json.load(file)["files"]
        items += [dict(item, file=f"{runtime}/{name}") for name, item in files.items()]
    for item in items:
        if not matches(os.path.join(directory, item["file"]), item):
            sys.exit(f"{directory}/{item['file']} does not match its manifest")


def _write_json(path, value, indent):
    with open(path + ".tmp", "w") as out:
        json.dump(value, out, indent=indent)
    os.replace(path + ".tmp", path)


def refresh(native, target, shared_node=None):
    """Records the bytes signing changed (macOS) in the manifests of the copy
    in native/, so the desktop's checks of the copies it installs pass."""
    teamhub = os.path.join(native, f"teamhub-{target}")
    path = os.path.join(teamhub, "manifest.json")
    if os.path.exists(path):
        with open(path) as file:
            manifest = json.load(file)
        for binary in manifest["binaries"].values():
            binary["sha256"] = sha256(os.path.join(teamhub, binary["file"]))
            binary["bytes"] = os.path.getsize(os.path.join(teamhub, binary["file"]))
        _write_json(path, manifest, 2)
    runtime = os.path.join(native, f"runtime-{target}")
    path = os.path.join(runtime, "manifest.json")
    if not os.path.exists(path):
        return
    with open(path) as file:
        manifest = json.load(file)
    if manifest.get("layout") != "directory":
        return
    files_path = os.path.join(runtime, manifest["directory"]["file"])
    root = os.path.dirname(files_path)
    with open(files_path) as file:
        files = json.load(file)
    for name, item in files["files"].items():
        full = os.path.join(root, name)
        size = os.path.getsize(full)
        # rcodesign only rewrites Mach-O files; skip re-hashing untouched JS/data files.
        if size != item["bytes"] or _is_macho(full):
            item["sha256"] = sha256(full)
            item["bytes"] = size
    _write_json(files_path, files, 1)
    directory_item = manifest["directory"]
    directory_item["sha256"] = sha256(os.path.join(runtime, directory_item["file"]))
    directory_item["bytes"] = os.path.getsize(os.path.join(runtime, directory_item["file"]))
    node_item = manifest["node"]
    if node_item.get("shared"):
        parts = _shared_node_parts(node_item, path)
        node_path = shared_node or os.path.normpath(
            os.path.join(native, "..", "..", "..", "..", *parts)
        )
    else:
        node_path = os.path.join(runtime, node_item["file"])
    node_item["sha256"] = sha256(node_path)
    node_item["bytes"] = os.path.getsize(node_path)
    _write_json(path, manifest, 2)
