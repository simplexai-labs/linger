"use strict";
// The trusted wrapper only exchanges JSON strings with the guest realm.
const version = process.versions.node.split(".").map(Number);
if (version[0] < 26 || (version[0] === 26 && version[1] < 5)) {
  throw new Error("UI runtime requires Node 26.5 or newer");
}
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const limits = JSON.parse(process.argv[1]);
const engineBase = pathToFileURL(limits.engineDirectory + path.sep);
const { QuickJS, Intrinsics } = await import(
  new URL("dist/index.js", engineBase)
);
const wasm = await WebAssembly.compile(
  await readFile(new URL("quickjs.wasm", engineBase)),
);
// Only this wrapper owns the protocol pipes. Neither VM receives host I/O,
// module loaders, native extensions, callbacks, or a shared memory object.
const wasi = () => ({ fd_write: () => 8, fd_fdstat_get: () => 8 });
let deadline = Infinity;
const options = {
  wasm,
  wasi,
  memoryLimit: limits.heapBytes,
  interruptHandler: () => performance.now() >= deadline,
};
const compiler = await QuickJS.create(options);
// QuickJS reports a promise as handled only after reporting it unhandled, and
// its promise handle is not a stable identity, so a count tracks the balance.
let unhandled = 0;
const guest = await QuickJS.create({
  ...options,
  intrinsics: Intrinsics.ALL & ~Intrinsics.EVAL,
  onUnhandledRejection(_promise, _reason, handled) {
    unhandled += handled ? -1 : 1;
  },
});
const drain = compiler.compile("__uiBridge.drain()");
let execution = 0,
  waiting = 0,
  active = false,
  dead = false;
function send(message) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text) >= limits.maxProtocolBytes)
    throw new Error("UI protocol frame exceeds byte limit");
  process.stdout.write(text + "\n");
}
function fail(message) {
  if (dead) return;
  dead = true;
  try {
    send({ type: "fatal", error: message.slice(0, 4096) });
  } finally {
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
// The CPU budget bounds guest work. The trusted bridge setup runs unbounded,
// so a slow host cannot fail the runtime before it is ready.
function evaluate(source, budgetMs = limits.pumpMs) {
  deadline = performance.now() + budgetMs;
  try {
    // Only bytecode produced by our own compiler enters the guest.
    using value = guest.evalBytecode(
      source === drain ? drain : compiler.compile(source),
    );
    guest.executePendingJobs();
    if (unhandled > 0) throw new Error("UI unhandled asynchronous rejection");
    return value.typeof === "string" ? value.toString() : undefined;
  } finally {
    deadline = Infinity;
  }
}
// This source is compiled in the guest alongside the other UI helpers. It
// captures no host state and compares only the two observations supplied to it.
function browserSnapshotHelpers() {
  const { parse, stringify } = JSON;
  const snapshotHeading = "### Snapshot";
  const diffHeading = "### Snapshot diff";
  const fence = "```";
  const yamlFence = fence + "yaml";
  const diffKey = "linger/browserSnapshotDiff";
  const reference = String.raw`\[ref=([A-Za-z0-9_-]+)\](?: \[cursor=pointer\])?(?: \[box=[^[\]]+\])?`;
  const refSuffix = new RegExp("^ " + reference + "$");
  const plainKey = String.raw`([a-z][a-z0-9-]*) (?:"[^"\\:#]*" )?(?:\[[a-z][a-z0-9-]*(?:=[a-z0-9-]+)?\] )*${reference}`;
  const singleQuotedKey = String.raw`'([a-z][a-z0-9-]*) (?:[^']|'')* ${reference}'`;
  const plainValue = String.raw`[A-Za-z0-9_./+][^:#\x00-\x1f]*`;
  const doubleQuotedValue = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}))*"`;
  const referenceRow = new RegExp(
    String.raw`^( *)- (?:${plainKey}|${singleQuotedKey})(:(?: (?:${plainValue}|${doubleQuotedValue}))?)?$`,
  );
  const urlRow = /^ *- \/url: (?:https?:\/\/|\/)[^\s"#']*$/;
  const unsupportedScalar = /^[|>&*!{}[\]#,@`%]|^[-?:](?:\s|$)/;
  const leadingSpace = /^\s/;
  const scalarDelimiter = /:(?:\s|$)|\s#/;
  const inlineComment = /\s#/;
  const maxRemovedSamples = 10;
  const maxAnonymousEdits = 128;

  function lineEndsAt(text, index) {
    return (
      index === text.length ||
      text[index] === "\n" ||
      text.startsWith("\r\n", index)
    );
  }

  function findLine(text, line, from = 0) {
    let index = text.indexOf(line, from);
    while (index !== -1) {
      if (
        (index === 0 || text[index - 1] === "\n") &&
        lineEndsAt(text, index + line.length)
      )
        return index;
      index = text.indexOf(line, index + line.length);
    }
    return -1;
  }

  function findSnapshot(text) {
    for (
      let heading = findLine(text, snapshotHeading);
      heading >= 0;
      heading = findLine(
        text,
        snapshotHeading,
        heading + snapshotHeading.length,
      )
    ) {
      const opening = text.indexOf("\n", heading) + 1;
      if (!opening) break;
      if (
        !text.startsWith(yamlFence, opening) ||
        !lineEndsAt(text, opening + yamlFence.length)
      )
        continue;
      const start = text.indexOf("\n", opening) + 1;
      if (!start) break;
      const closing = findLine(text, fence, start);
      if (closing < 0) break;
      if (closing === start) continue;
      const stop = text[closing - 2] === "\r" ? closing - 2 : closing - 1;
      return {
        start: heading,
        end: closing + fence.length,
        yaml: text.slice(start, stop),
      };
    }
    return null;
  }

  function observation(value) {
    if (typeof value === "string" || typeof value?.text === "string") {
      const text = typeof value === "string" ? value : value.text;
      return { text, block: findSnapshot(text) };
    }
    const result = Array.isArray(value?.content) ? value : { content: [] };
    const texts = [];
    let block = null;
    let partIndex = -1;
    for (let index = 0; index < result.content.length; index++) {
      const part = result.content[index];
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      texts.push(part.text);
      if (partIndex < 0) partIndex = index;
      if (block) continue;
      block = findSnapshot(part.text);
      if (block) partIndex = index;
    }
    return { text: texts.join("\n"), result, partIndex, block };
  }

  function section(text, name) {
    const heading = findLine(text, "### " + name);
    if (heading < 0) return null;
    const start = text.indexOf("\n", heading) + 1;
    if (!start) return "";
    const end = text.indexOf("\n### ", start - 1);
    return end < 0 ? text.slice(start) : text.slice(start, end + 1);
  }

  function page(text) {
    const url = /^- Page URL: (.+?)\r?$/m.exec(
      section(text, "Page") ?? "",
    )?.[1];
    if (!url) return null;
    const tabs = section(text, "Open tabs");
    const tab =
      tabs === null
        ? ["0", url]
        : /^- (\d+): \(current\) \[.*\]\((.*)\)(?: \[crashed\])?\r?$/m
            .exec(tabs)
            ?.slice(1);
    return tab ? { url, tab: tab.join(": ") } : null;
  }

  function doubleQuoteEnd(text, start) {
    let end = text.indexOf('"', start + 1);
    while (end >= 0 && text[end - 1] === "\\") {
      let backslash = end - 1;
      while (text[backslash - 1] === "\\") backslash--;
      if ((end - backslash) % 2 === 0) break;
      end = text.indexOf('"', end + 1);
    }
    return end;
  }

  // Playwright adds YAML hex escapes to the escapes understood by JSON.
  function normalizeHexEscapes(raw) {
    let normalized = "";
    let start = 0;
    for (
      let index = raw.indexOf("\\");
      index >= 0;
      index = raw.indexOf("\\", index + 2)
    ) {
      if (raw[index + 1] !== "x") continue;
      normalized += raw.slice(start, index) + "\\u00";
      start = index + 2;
    }
    return normalized + raw.slice(start);
  }

  function quotedScalar(text) {
    if (text.startsWith("'")) {
      const match = /^'((?:[^']|'')*)'/.exec(text);
      return (
        match && {
          value: match[1].replace(/''/g, "'"),
          rest: text.slice(match[0].length),
        }
      );
    }
    const end = doubleQuoteEnd(text, 0);
    if (end < 0) return null;
    const raw = text.slice(0, end + 1);
    try {
      const value = parse(raw.includes("\\x") ? normalizeHexEscapes(raw) : raw);
      return { value, rest: text.slice(end + 1) };
    } catch {
      return null;
    }
  }

  function plainKeyEnd(text) {
    let start;
    let quote = text.indexOf('"');
    let colon = text.indexOf(":");
    while (quote !== -1 || colon !== -1) {
      if (quote !== -1 && (colon === -1 || quote < colon)) {
        const end = doubleQuoteEnd(text, quote);
        if (end < 0) return -1;
        start = end + 1;
        quote = text.indexOf('"', start);
      } else {
        if (colon === text.length - 1 || text[colon + 1] === " ") return colon;
        start = colon + 1;
      }
      colon = text.indexOf(":", start);
    }
    return text.length;
  }

  function labelRef(label) {
    if (!label.endsWith("]")) return undefined;
    const suffix = label.lastIndexOf(" [ref=");
    if (suffix < 0) return undefined;
    return refSuffix.exec(label.slice(suffix))?.[1];
  }

  // Playwright emits one sequence item per line: a label, optionally followed
  // by a scalar value or the indented children of that label.
  function parseRow(row) {
    // These forms expose the role and ref without decoding the label or value.
    const common = referenceRow.exec(row);
    if (common) {
      const indent = common[1].length;
      return indent % 2
        ? null
        : {
            indent,
            role: common[2] ?? common[4],
            ref: common[3] ?? common[5],
            branch: common[6] === ":",
          };
    }
    let indent = 0;
    while (row.charCodeAt(indent) === 32) indent++;
    if (indent % 2 || !row.startsWith("- ", indent)) return null;
    const text = row.slice(indent + 2);
    if (!text || leadingSpace.test(text) || unsupportedScalar.test(text))
      return null;
    let label, tail;
    if (text[0] === "'" || text[0] === '"') {
      const quoted = quotedScalar(text);
      if (!quoted) return null;
      label = quoted.value;
      tail = quoted.rest;
    } else {
      const end = plainKeyEnd(text);
      if (end < 0) return null;
      label = text.slice(0, end);
      tail = text.slice(end);
      if (label.includes("#") && inlineComment.test(label)) return null;
    }
    if (!label) return null;
    let branch = tail === ":";
    if (tail && !branch) {
      if (!tail.startsWith(": ")) return null;
      const value = tail.slice(2).trim();
      if (unsupportedScalar.test(value)) return null;
      if (value[0] === "'" || value[0] === '"') {
        const quoted = quotedScalar(value);
        if (!quoted || quoted.rest) return null;
      } else if (scalarDelimiter.test(value)) {
        return null;
      }
      branch = value === "";
    }
    const space = label.indexOf(" ");
    return {
      indent,
      branch,
      ref: labelRef(label),
      role: space < 0 ? label : label.slice(0, space),
    };
  }

  function tree(yaml, previous) {
    const rows = yaml.split("\n");
    const refAt = [];
    const ownerAt = [];
    // Retained refs already have an index in the previous tree.
    const refs = new Map();
    const orderedRefs = [];
    const parents = [];
    let lastSlotRow = -1;
    let shift = 0;
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index];
      if (row.endsWith("\r")) rows[index] = row = row.slice(0, -1);
      // Reuse a validated label only when the whole row matches. A retained
      // ref lets subsequent rows line up again after an insertion or removal.
      const aligned = previous?.refAt[index + shift];
      const cached =
        aligned && previous.rows[aligned.start] === row ? aligned : undefined;
      const parsed = cached?.parsed ?? parseRow(row);
      if (!parsed) return null;
      const depth = parsed.indent / 2;
      if (depth > parents.length) return null;
      while (parents.length > depth) {
        const closed = refAt[parents.pop()];
        if (closed) closed.end = index;
      }
      const parent = depth ? parents[depth - 1] : -1;
      const owner = depth ? (refAt[parent] ?? ownerAt[parent]) : undefined;
      const ref = parsed.ref;
      let url;
      let endsWithURL = false;
      // Playwright places a link's URL first. A validated scalar can be read
      // with its owner, including any rest of the branch on the next iteration.
      if (
        ref &&
        parsed.role === "link" &&
        parsed.branch &&
        index + 1 < rows.length
      ) {
        let child = rows[index + 1];
        if (child.endsWith("\r")) child = child.slice(0, -1);
        if (
          cached?.url === child ||
          (!child.endsWith(":") &&
            urlRow.test(child) &&
            child.indexOf("-") === parsed.indent + 2)
        ) {
          url = child;
          endsWithURL = rows[index + 2]?.charCodeAt(parsed.indent) !== 32;
        }
      }
      let node;
      if (ref) {
        const old = cached ?? previous?.refs.get(ref);
        if (old ? old.match : refs.has(ref)) return null;
        node = {
          start: index,
          end: endsWithURL
            ? index + 2
            : parsed.branch
              ? rows.length
              : index + 1,
          parsed,
          owner,
          hasRefChild: false,
          lastAnonymous: url === undefined ? -1 : index + 1,
          match: old,
          url,
        };
        if (old) {
          old.match = node;
          shift = old.start - index;
        } else {
          refs.set(ref, node);
        }
        orderedRefs.push(node);
        if (owner) owner.hasRefChild = true;
      } else if (owner) {
        owner.lastAnonymous = index;
      } else {
        lastSlotRow = index;
      }
      refAt.push(node);
      ownerAt.push(owner);
      if (parsed.branch && !endsWithURL) parents.push(index);
      if (url !== undefined) {
        rows[++index] = url;
        refAt.push(undefined);
        ownerAt.push(node);
      }
    }
    return {
      rows,
      refAt,
      ownerAt,
      refs,
      orderedRefs,
      lastSlotRow,
      rootHasAnonymous: lastSlotRow >= 0,
    };
  }

  function matchReferences(before, after) {
    let last = -1;
    for (const old of before.orderedRefs) {
      const next = old.match;
      if (!next) continue;
      if (
        old.owner?.parsed.ref !== next.owner?.parsed.ref ||
        old.parsed.role !== next.parsed.role ||
        next.start <= last
      )
        return false;
      if (old.hasRefChild || next.hasRefChild) {
        if (old.lastAnonymous >= 0) {
          old.compareSlots = true;
          before.lastSlotRow = Math.max(before.lastSlotRow, old.lastAnonymous);
        }
        if (next.lastAnonymous >= 0) {
          next.compareSlots = true;
          after.lastSlotRow = Math.max(after.lastSlotRow, next.lastAnonymous);
        }
      }
      last = next.start;
    }
    return last >= 0;
  }

  // A retained ref starts a new slot in its owner's anonymous content. For
  // leaves, a contiguous range suffices and the scan skips their descendants.
  function anonymousSlots(tree) {
    const owners = new Map();
    let pendingAnchors = 0;
    for (
      let i = 0;
      i <= tree.lastSlotRow || (pendingAnchors && i < tree.rows.length);
      i++
    ) {
      const node = tree.refAt[i];
      const parent = tree.ownerAt[i];
      if (parent ? parent.compareSlots : tree.rootHasAnonymous) {
        const key = parent?.parsed.ref;
        let owner = owners.get(key);
        if (!owner) {
          owner = { slots: new Map(), left: undefined, slot: undefined };
          owners.set(key, owner);
        }
        if (!node) {
          if (!owner.slot) {
            owner.slot = { rows: [], right: undefined };
            owner.slots.set(owner.left, owner.slot);
            if (!owner.left) pendingAnchors++;
          }
          owner.slot.rows.push(i);
        } else if (node.match) {
          const ref = node.parsed.ref;
          if (owner.slot && !owner.left) {
            owner.slot.right = ref;
            pendingAnchors--;
          }
          owner.left = ref;
          owner.slot = undefined;
        }
      }
      if (node && (!node.match || (!node.hasRefChild && !node.compareSlots)))
        i = node.end - 1;
    }
    return owners;
  }

  // Search the edit distance in increasing order. At each distance the
  // frontier records how far we can advance on each old/new row diagonal.
  function anonymousEdits(oldLength, newLength, equal) {
    const limit = Math.min(oldLength + newLength, maxAnonymousEdits);
    if (Math.abs(oldLength - newLength) > limit) return null;
    const offset = limit + 1;
    const frontier = new Int32Array(2 * offset + 1);
    const trace = [];
    function fromInsertion(previous, distance, diagonal) {
      return (
        diagonal === -distance ||
        (diagonal !== distance &&
          previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
      );
    }
    function backtrack(distance) {
      const removed = [];
      const added = [];
      let x = oldLength;
      let y = newLength;
      for (; distance > 0; distance--) {
        const previous = trace[distance];
        const diagonal = x - y;
        const insertion = fromInsertion(previous, distance, diagonal);
        const predecessor = diagonal + (insertion ? 1 : -1);
        x = previous[offset + predecessor];
        y = x - predecessor;
        if (insertion) added.push(y);
        else removed.push(x);
      }
      return { removed: removed.reverse(), added: added.reverse() };
    }
    for (let d = 0; d <= limit; d++) {
      trace.push(frontier.slice());
      for (let diagonal = -d; diagonal <= d; diagonal += 2) {
        const k = offset + diagonal;
        let x = fromInsertion(frontier, d, diagonal)
          ? frontier[k + 1]
          : frontier[k - 1] + 1;
        let y = x - diagonal;
        while (x < oldLength && y < newLength && equal(x, y)) {
          x++;
          y++;
        }
        if (x >= oldLength && y >= newLength) return backtrack(d);
        frontier[k] = x;
      }
    }
    return null;
  }

  function compare(before, after) {
    const changes = [];
    let removed = 0;
    let replacedRange = false;

    function renderContext(tree, parent, position) {
      if (parent)
        changes.push(
          "    under " + tree.rows[parent.start].slice(parent.parsed.indent),
        );
      if (position) changes.push("    " + position);
    }
    function render(marker, tree, index, branch = false, position) {
      const node = tree.refAt[index];
      const parent = tree.ownerAt[index];
      const indent = node
        ? node.parsed.indent
        : parent
          ? parent.parsed.indent + 2
          : 0;
      changes.push("  " + marker + " " + tree.rows[index].slice(indent));
      if (branch) {
        for (let child = index + 1; child < node.end; child++)
          changes.push("    " + tree.rows[child].slice(indent));
      }
      renderContext(tree, parent, position);
    }
    function remove(index, position) {
      if (++removed <= maxRemovedSamples)
        render("-", before, index, false, position);
    }

    function compareRange(
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      position,
      oldIndexes,
      newIndexes,
    ) {
      const oldAt = (i) => oldIndexes?.[i] ?? i;
      const newAt = (i) => newIndexes?.[i] ?? i;
      const equal = (i, j) => before.rows[oldAt(i)] === after.rows[newAt(j)];
      while (
        oldStart < oldEnd &&
        newStart < newEnd &&
        equal(oldStart, newStart)
      ) {
        oldStart++;
        newStart++;
      }
      while (
        oldEnd > oldStart &&
        newEnd > newStart &&
        equal(oldEnd - 1, newEnd - 1)
      ) {
        oldEnd--;
        newEnd--;
      }
      const oldLength = oldEnd - oldStart;
      const newLength = newEnd - newStart;
      if (oldLength && newLength && oldLength + newLength > 2) {
        const edits = anonymousEdits(oldLength, newLength, (x, y) =>
          equal(oldStart + x, newStart + y),
        );
        if (edits) {
          for (const x of edits.removed) remove(oldAt(oldStart + x), position);
          for (const y of edits.added)
            render("+", after, newAt(newStart + y), false, position);
        } else {
          // A bounded search can leave the exact changes within this slot
          // unresolved. Report a replacement without labelling each row new.
          replacedRange = true;
          changes.push(
            "  ~ anonymous range replaced (" +
              oldLength +
              " old rows, " +
              newLength +
              " new rows)",
          );
          const parent = after.ownerAt[newAt(newStart)];
          const indent = parent ? parent.parsed.indent + 2 : 0;
          for (let i = newStart; i < newEnd; i++)
            changes.push("    " + after.rows[newAt(i)].slice(indent));
          renderContext(after, parent, position);
        }
        return;
      }
      for (let i = oldStart; i < oldEnd; i++) remove(oldAt(i), position);
      for (let i = newStart; i < newEnd; i++)
        render("+", after, newAt(i), false, position);
    }

    // Preserve the removal sample budget for references before anonymous rows.
    for (const node of before.orderedRefs) {
      if (!node.match && (!node.owner || node.owner.match)) remove(node.start);
    }
    let coveredUntil = 0;
    for (const node of after.orderedRefs) {
      if (node.start < coveredUntil) continue;
      const old = node.match;
      if (!old) {
        render("+", after, node.start, true);
        coveredUntil = node.end;
        continue;
      }
      if (before.rows[old.start] !== after.rows[node.start])
        render("~", after, node.start);
      if (!old.hasRefChild && !node.hasRefChild) {
        // All descendants are anonymous. Skip the shared rows in-place;
        // unchanged leaves never allocate slots or enter the edit search.
        let x = old.start + 1;
        let y = node.start + 1;
        while (
          x < old.end &&
          y < node.end &&
          before.rows[x] === after.rows[y]
        ) {
          x++;
          y++;
        }
        if (x < old.end || y < node.end)
          compareRange(x, old.end, y, node.end, "");
      }
    }

    const oldOwners = anonymousSlots(before);
    const newOwners = anonymousSlots(after);
    function compareSlot(left, old, next) {
      const right = old?.right ?? next?.right;
      const position = left
        ? "after [ref=" + left + "]"
        : right
          ? "before [ref=" + right + "]"
          : "";
      compareRange(
        0,
        old?.rows.length ?? 0,
        0,
        next?.rows.length ?? 0,
        position,
        old?.rows,
        next?.rows,
      );
    }
    for (const [ref, owner] of oldOwners) {
      const nextSlots = newOwners.get(ref)?.slots;
      for (const [left, slot] of owner.slots)
        compareSlot(left, slot, nextSlots?.get(left));
    }
    for (const [ref, owner] of newOwners) {
      const oldSlots = oldOwners.get(ref)?.slots;
      for (const [left, slot] of owner.slots) {
        if (!oldSlots?.has(left)) compareSlot(left, undefined, slot);
      }
    }

    if (removed > maxRemovedSamples)
      changes.push("  ... " + (removed - maxRemovedSamples) + " more removed");
    if (!changes.length)
      return "no_change: the accessibility tree matches the previous snapshot.";
    changes.push(
      replacedRange
        ? "Call ui.browser.snapshot({}) for the full tree."
        : "Unchanged elements omitted; call ui.browser.snapshot({}) for the full tree.",
    );
    return changes.join("\n");
  }

  function report(before, after) {
    if (!before.block || !after.block) return { reason: "missing_snapshot" };
    const oldPage = page(before.text),
      newPage = page(after.text);
    if (
      !oldPage ||
      !newPage ||
      oldPage.url !== newPage.url ||
      oldPage.tab !== newPage.tab
    )
      return { reason: "page_changed" };
    const oldTree = tree(before.block.yaml);
    const newTree = oldTree && tree(after.block.yaml, oldTree);
    if (!oldTree || !newTree) return { reason: "unparseable_snapshot" };
    if (!matchReferences(oldTree, newTree)) return { reason: "layout_changed" };
    return { diff: "### Snapshot diff\n" + compare(oldTree, newTree) };
  }

  function diff(prev, next) {
    const after = observation(next);
    const outcome = report(observation(prev), after);
    const update = (text) => {
      if (outcome.diff) {
        const { start, end } = after.block;
        return text.slice(0, start) + outcome.diff + text.slice(end);
      }
      if (!after.block) {
        return (
          "Note: the newer result has no full snapshot (reason: missing_snapshot).\n\n" +
          text
        );
      }
      const { start } = after.block;
      const note =
        "Note: full snapshot returned instead of diff (reason: " +
        outcome.reason +
        ").\n\n";
      return text.slice(0, start) + note + text.slice(start);
    };
    const result = { ...after.result };
    if (after.result) {
      result.content = after.result.content.slice();
      if (after.partIndex >= 0) {
        const part = result.content[after.partIndex];
        result.content[after.partIndex] = { ...part, text: update(part.text) };
      } else {
        result.content.unshift({ type: "text", text: update("") });
      }
    } else {
      result.content = [{ type: "text", text: update(after.text) }];
    }
    if (outcome.diff) result._meta = { ...next?._meta, [diffKey]: true };
    return result;
  }

  function ref(snapshot, role, name) {
    const message =
      "ui.ref requires a full snapshot. Pass the result of ui.browser.snapshot({}).";
    if (snapshot?._meta?.[diffKey] === true) throw new Error(message);
    const text =
      typeof snapshot === "string"
        ? snapshot
        : typeof snapshot?.text === "string"
          ? snapshot.text
          : this.text(snapshot);
    if (findLine(text, diffHeading) >= 0) throw new Error(message);
    const prefix = role + " " + stringify(name) + " ";
    const refs = [];
    for (const line of text.split(/\r?\n/)) {
      const row = line.trimStart();
      if (!row.startsWith("- ")) continue;
      let label = row.slice(2);
      if (label[0] === "'" || label[0] === '"') {
        const quoted = quotedScalar(label);
        if (!quoted || (quoted.rest && !quoted.rest.startsWith(":"))) continue;
        label = quoted.value;
      }
      if (!label.startsWith(prefix)) continue;
      const match =
        /^(?:\[[^\]\n]*\] )*\[ref=([a-zA-Z0-9_-]+)\](?=[: \t]|$)/.exec(
          label.slice(prefix.length),
        );
      if (match) refs.push(match[1]);
    }
    if (refs.length !== 1)
      throw new Error(
        "Expected one matching control; inspect the current snapshot",
      );
    return refs[0];
  }

  return { diff, ref };
}

// Functions, Promises and errors below originate inside the context. Go treats
// every bridge request as untrusted and applies its own limits and validation.
evaluate(
  `(() => {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse;
  const {diff, ref} = (${browserSnapshotHelpers.toString()})();
  const pending = new Map();
  let queue = [], outputs = [], outputSize = 0, next = 0;
  let active = false, completed = false, finalValue = null, failure = '', epoch = 0;
  const maxCalls = ${limits.maxCalls}, maxOutput = ${limits.maxOutputBytes}, maxFrame = ${limits.maxProtocolBytes};
  const clone = value => {
    const text = stringify(value);
    if (text === undefined) return null;
    if (text.length > maxFrame) throw new Error('UI value exceeds byte limit');
    return parse(text);
  };
  const errorText = error => {
    try { return String(error && error.message || error).slice(0, 4096); }
    catch { return 'UI script failed'; }
  };
  const revisions = {browser:0, computer:0};
  const call = (owner, namespace, method, args) => {
    if (owner !== epoch || !active || completed) return Promise.reject(new Error('UI execution is not active'));
    // Serialize before taking an ID: a thrown argument must not leave a gap
    // in the call sequence that the Daemon validates.
    const argumentsValue = clone(args === undefined ? {} : args);
    if (++next > maxCalls) {
      failure = 'UI call limit exceeded';
      return Promise.reject(new Error(failure));
    }
    if (namespace === 'browser' || namespace === 'computer') ++revisions[namespace];
    const id = next;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    queue.push({ type: 'call', id, namespace, method, arguments: argumentsValue });
    return promise;
  };
  const namespace = (owner, name) => new Proxy(Object.create(null), {
    get(_, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      return args => call(owner, name, key, args);
    }
  });
  const makeUI = owner => Object.freeze({
    computer: namespace(owner, 'computer'), browser: namespace(owner, 'browser'),
    text(result) {
      return result.content.filter(part => part.type === 'text').map(part => part.text).join('\\n');
    },
    diff, ref,
    async page(url) {
      const ui = this;
      const b = ui.browser;
      if (url !== undefined) await b.navigate({url});
      const read = async () => {
        const pending = b.snapshot({});
        const revision = revisions.browser;
        return view(await pending, revision);
      };
      const view = (snapshot, revision) => {
        const act = async (method, argumentsForView) => {
          if (revision !== revisions.browser) throw new Error('Page observation expired; observe again');
          const pending = b[method](argumentsForView());
          const nextRevision = revisions.browser;
          const result = await pending;
          if (nextRevision !== revisions.browser) throw new Error('Page changed during action; observe again');
          // Some Playwright actions return delivery only. Read once, without replaying the input.
          const next = result.content?.some(p => p.type === 'text' && /^### Snapshot\\n\`\`\`yaml\\n/m.test(p.text))
            ? view(result, nextRevision) : await read();
          return Object.freeze({...result, ...next});
        };
        return Object.freeze({
          text: ui.text(snapshot),
          click: (role, name) => act('click', () => ({target: ui.ref(snapshot, role, name)})),
          type: (role, name, text) => act('type', () => ({target: ui.ref(snapshot, role, name), text})),
          select: (role, name, values) => act('select_option', () => ({target: ui.ref(snapshot, role, name), values})),
          fill: fields => act('fill_form', () => {
            if (!Array.isArray(fields) || !fields.length) throw new Error('Expected at least one form field');
            const targets = new Set();
            return {fields: fields.map(({type, name, value}) => {
              const target = ui.ref(snapshot, type, name);
              if (targets.has(target)) throw new Error('Form field appears more than once');
              targets.add(target);
              return {target, type, name, value};
            })};
          }),
        });
      };
      return Object.freeze({observe: read});
    },
    window(pid, window_id) {
      const c = this.computer;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(window_id) || window_id <= 0)
        throw new Error('A window requires positive numeric process and window identifiers');
      const view = (result, revision) => {
        const prefix = 'window_id=' + window_id + ' pid=' + pid + ' ';
        const state = result.content?.find(part => part.type === 'text' && part.text.startsWith(prefix));
        const text = state?.text ?? 'Window tree unavailable; inspect the result or observe again.';
        return Object.freeze({
          ...result, text,
          async click(role, name) {
            if (revision !== revisions.computer) throw new Error('Window observation expired; observe again');
            const stamp = /^.*?\\bsnapshot_id=(s[0-9a-f]+)\\b/.exec(text);
            const rows = [];
            for (const line of text.split('\\n')) {
              const match = /^\\s*(?:-\\s+)?\\[(\\d+)\\]\\s+(AX\\w+)\\s+("(?:[^"\\\\]|\\\\.)*")(?=\\s|$)/.exec(line);
              if (match && match[2] === role && match[3] === stringify(name)) rows.push(match[1]);
            }
            if (!stamp || rows.length !== 1) throw new Error('Expected one named window control with a snapshot token');
            const pending = c.click({pid, window_id, element_token: stamp[1] + ':' + rows[0]});
            const nextRevision = revisions.computer;
            return view(await pending, nextRevision);
          }
        });
      };
      const observe = async () => {
        const pending = c.get_window_state({pid, window_id});
        const revision = revisions.computer;
        return view(await pending, revision);
      };
      return Object.freeze({observe});
    },
    help(topic = "") {
      if (typeof topic !== 'string' || topic.length > 256) throw new Error('UI help requires a topic');
      return call(owner, 'help', topic, {});
    },
    emit(value) {
      if (owner !== epoch || !active || completed) throw new Error('UI execution is not active');
      const copy = clone(value), size = stringify(copy).length;
      if (outputSize + size > maxOutput) {
        failure = 'UI output exceeds byte limit'; throw new Error(failure);
      }
      outputSize += size; outputs.push(copy);
    }
  });
  Object.defineProperty(globalThis, 'state', { value: Object.create(null) });
  Object.defineProperty(globalThis, '__uiBridge', { value: Object.freeze({
    start(fn) {
      if (active || pending.size) throw new Error('UI runtime is busy');
      queue = []; outputs = []; outputSize = 0; next = 0;
      completed = false; failure = ''; finalValue = null; active = true;
      fn(makeUI(++epoch)).then(value => { finalValue = value; completed = true; }, error => {
        failure = errorText(error); completed = true;
      });
    },
    reply(text) {
      const message = parse(text), item = pending.get(message.id);
      if (!item) throw new Error('Unknown UI reply');
      pending.delete(message.id);
      if (typeof message.error === 'string') item.reject(new Error(message.error));
      else item.resolve(message.value);
    },
    drain() {
      if (failure) return stringify({ type: 'done', error: failure });
      if (completed) {
        if (pending.size) return stringify({ type: 'done', error: 'UI calls must be awaited before execution completes' });
        const value = clone(finalValue);
        if (outputSize + stringify(value).length > maxOutput) throw new Error('UI output exceeds byte limit');
        active = false;
        return stringify({ type: 'done', value, output: outputs });
      }
      if (queue.length) return stringify(queue.shift());
      return '';
    }
  }) });
})()`,
  Infinity,
);
function pump() {
  if (dead || !active || waiting) return;
  if (process.memoryUsage().rss > limits.rssBytes)
    return fail("UI RSS supervision limit exceeded");
  const text = evaluate(drain);
  if (typeof text !== "string") throw new Error("Invalid UI bridge result");
  if (!text) return;
  if (Buffer.byteLength(text) >= limits.maxProtocolBytes)
    throw new Error("UI protocol frame exceeds byte limit");
  const message = JSON.parse(text);
  if (message.type === "call") waiting = message.id;
  else if (message.type === "done") active = false;
  else throw new Error("Invalid UI bridge message");
  send({ ...message, execution });
}
function receive(message) {
  if (dead) return;
  if (message.type === "exec") {
    if (
      active ||
      waiting ||
      typeof message.code !== "string" ||
      !Number.isSafeInteger(message.execution)
    )
      throw new Error("Invalid UI execution");
    execution = message.execution;
    active = true;
    evaluate(
      '__uiBridge.start(async function(ui) {\n"use strict";\n' +
        message.code +
        "\n})",
    );
  } else if (message.type === "reply") {
    if (
      !active ||
      !waiting ||
      message.execution !== execution ||
      message.id !== waiting
    )
      throw new Error("Invalid UI reply");
    waiting = 0;
    evaluate(
      "__uiBridge.reply(" + JSON.stringify(JSON.stringify(message)) + ")",
    );
  } else throw new Error("Invalid UI request");
  pump();
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  if (dead) return;
  try {
    input = Buffer.concat([input, chunk]);
    for (;;) {
      const end = input.indexOf(10);
      if (end === -1) break;
      if (end >= limits.maxProtocolBytes)
        throw new Error("UI protocol frame exceeds byte limit");
      const line = input.subarray(0, end).toString("utf8");
      input = input.subarray(end + 1);
      receive(JSON.parse(line));
    }
    if (input.length >= limits.maxProtocolBytes)
      throw new Error("UI protocol frame exceeds byte limit");
  } catch (error) {
    fail(`UI protocol or execution failed: ${error?.message ?? error}`);
  }
});
process.stdin.on("end", () => {
  dead = true;
  process.exitCode = 0;
});
process.on("unhandledRejection", () =>
  fail("UI unhandled asynchronous rejection"),
);
const supervision = setInterval(() => {
  if (dead) {
    clearInterval(supervision);
    return;
  }
  try {
    if (process.memoryUsage().rss > limits.rssBytes)
      return fail("UI RSS supervision limit exceeded");
    pump();
  } catch {
    fail("UI execution exceeded its CPU or serialization budget");
  }
}, 10);
supervision.unref();
send({ type: "ready" });
