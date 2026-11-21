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
// Functions, Promises and errors below originate inside the context. Go treats
// every bridge request as untrusted and applies its own limits and validation.
evaluate(
  `(() => {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse;
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
  const call = (owner, namespace, method, args, fullBrowserSnapshot) => {
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
    queue.push({ type: 'call', id, namespace, method, arguments: argumentsValue, fullBrowserSnapshot });
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
    ref(snapshot, role, name) {
      if (snapshot?._meta?.['linger/browserSnapshotDiff'] === true) {
        throw new Error('ui.ref requires a full snapshot. Pass the result of ui.browser.snapshot({}).');
      }
      const prefix = '- ' + role + ' ' + stringify(name) + ' ';
      const refs = [];
      for (const line of this.text(snapshot).split('\\n')) {
        let row = line.trimStart();
        // Playwright quotes an entire YAML key when a name contains e.g. ": " or " #".
        if (row.startsWith("- '")) {
          const quoted = /^- '((?:[^']|'')*)'(?=:|$)/.exec(row);
          if (!quoted) continue;
          row = '- ' + quoted[1].replace(/''/g, "'");
        }
        if (!row.startsWith(prefix)) continue;
        const match = /^((?:\\[[^\\]\\n]*\\] )*)\\[ref=([a-zA-Z0-9_-]+)\\](?=[: \\t]|$)/.exec(row.slice(prefix.length));
        if (match) refs.push(match[2]);
      }
      if (refs.length !== 1) throw new Error('Expected one matching control; inspect the current snapshot');
      return refs[0];
    },
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
          const pending = call(owner, 'browser', method, argumentsForView(), true);
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
