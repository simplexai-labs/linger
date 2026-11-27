import { open } from "node:fs/promises";
import path from "node:path";
import { decodeInlineEscapes } from "./content-segments.js";
import type {
  CommandArguments,
  CommandInputReader,
  CommandOption,
  NormalizedCommandInput,
} from "./command-definition.js";
import { CliError } from "./errors.js";
import {
  conflictingFlags,
  echo,
  fileFailure,
  fileSystemError,
  inputIssue,
  invalidFlag,
  invalidInput,
  jsonSyntaxError,
  mebibytes,
  missingFlag,
  textPosition,
  unknownFieldMessage,
  usageError,
} from "./input-issues.js";

const byteLimit = 5 * 1024 * 1024;
export function option(
  args: CommandArguments,
  name: string,
): string | undefined {
  const found = args.options[name];
  if (found && found.length > 1) throw repeatedFlag(name);
  return found?.[0];
}
export function values(
  args: CommandArguments,
  name: string,
): readonly string[] {
  return args.options[name] ?? [];
}
/**
 * The one flag of `flags` that was given. More than one is a conflict;
 * none is missing unless `required` is false.
 */
export function oneOf(
  args: CommandArguments,
  flags: readonly string[],
  required = true,
): string | undefined {
  const given = flags.filter((name) => args.options[name] !== undefined);
  if (given.length > 1) throw conflictingFlags(given);
  if (!given.length && required) throw missingFlag(flags);
  return given[0];
}
export function requiredOption(args: CommandArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw missingFlag([name]);
  return value;
}
export function assertPositionals(
  args: CommandArguments,
  min: number,
  max = min,
): void {
  const count = args.positionals.length;
  if (count < min || count > max) {
    const expected =
      min === max
        ? `${min}`
        : max === Infinity
          ? `at least ${min}`
          : `${min} to ${max}`;
    throw usageError(
      `This command takes ${expected} positional argument${expected === "1" ? "" : "s"}; got ${count}.`,
      [
        inputIssue(
          "arguments",
          "out_of_range",
          `must be ${expected} positional argument${expected === "1" ? "" : "s"}; got ${count}.`,
        ),
      ],
    );
  }
}
function repeatedFlag(name: string): CliError {
  return usageError(`${name} can be given only once.`, [
    inputIssue(name, "conflict", "give only one value."),
  ]);
}
function stdinTwice(name: string): CliError {
  return usageError("Only one input may read stdin.", [
    inputIssue(name, "conflict", "give - to only one file flag."),
  ]);
}
export function parseArguments(
  args: readonly string[],
  definitions: Readonly<Record<string, CommandOption>>,
): CommandArguments {
  const options: Record<string, string[]> = Object.create(null);
  const positionals: string[] = [];
  const ordered: { name: string; value: string }[] = [];
  let literal = false;
  let stdin = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (literal || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    const definition = Object.hasOwn(definitions, name)
      ? definitions[name]
      : undefined;
    if (!definition)
      throw usageError(`Unknown flag ${name}.`, [
        inputIssue(
          name,
          "unknown_field",
          unknownFieldMessage(
            Object.keys(definitions).filter(
              (flag) => !["-h", "--help", "--schema"].includes(flag),
            ),
          ),
        ),
      ]);
    if (options[name] && !definition.repeatable) throw repeatedFlag(name);
    if (definition.boolean && separator >= 0)
      throw usageError(`${name} takes no value.`, [
        inputIssue(
          name,
          "invalid_value",
          `takes no value; got ${echo(token.slice(separator + 1))}.`,
        ),
      ]);
    const value = definition.boolean
      ? "true"
      : separator >= 0
        ? token.slice(separator + 1)
        : args[++index];
    if (value === undefined)
      throw usageError(`${name} needs a value.`, [
        inputIssue(name, "missing", "required; give a value after the flag."),
      ]);
    if (value.includes("\0"))
      throw invalidFlag(
        name,
        "invalid_value",
        "must not contain NUL characters.",
      );
    // "-" means stdin only where a path is expected. The inline twin of a
    // file flag takes "-" literally, which nobody means to send.
    const twin = name === "--content" ? "--file" : `${name}-file`;
    if (value === "-" && Object.hasOwn(definitions, twin))
      throw invalidInput(
        `${name} takes the value itself and does not read stdin.`,
        [
          inputIssue(
            name,
            "invalid_value",
            `"-" would be ${name === "--content" ? "sent" : "read"} as literal text; to read stdin use ${twin} -.`,
          ),
        ],
      );
    if (value === "-" && (name === "--file" || name.endsWith("-file"))) {
      if (stdin) throw stdinTwice(name);
      stdin = true;
    }
    (options[name] ??= []).push(value);
    ordered.push({ name, value });
  }
  return { options, positionals, ordered };
}

/**
 * One JSON value from a flag (`--item`) or a file flag (`--item-file`).
 * Every failure names that flag, with the line and column for syntax.
 */
export function parseJsonValue(
  text: string,
  flag = "input",
  fileTwin?: string,
): unknown {
  if (Buffer.byteLength(text) > byteLimit)
    throw invalidFlag(
      flag,
      "out_of_range",
      `must be at most ${mebibytes(byteLimit)} of JSON; got ${mebibytes(Buffer.byteLength(text))}.`,
    );
  const syntax = jsonSyntaxError(text);
  if (syntax)
    throw invalidInput(
      fileTwin
        ? `${flag} is not valid JSON. Pass JSON through ${fileTwin} <path|-> if your shell strips quotes.`
        : `${flag} is not valid JSON.`,
      [
        inputIssue(
          flag,
          "invalid_json",
          `line ${syntax.line}, column ${syntax.column}: ${syntax.reason}.`,
        ),
      ],
    );
  const result: unknown = JSON.parse(text);
  // JSON.parse keeps the last of duplicate properties. Inspect the token
  // stream so an escaped alias cannot silently replace an earlier value.
  const stack: { keys?: Set<string>; expectingKey: boolean }[] = [];
  const tokens = text.matchAll(
    /"(?:\\.|[^"\\])*"|[{}[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu,
  );
  for (const match of tokens) {
    const token = match[0];
    if (token === "{" || token === "[")
      stack.push({
        ...(token === "{" ? { keys: new Set<string>() } : {}),
        expectingKey: token === "{",
      });
    else if (token === "}" || token === "]") stack.pop();
    else {
      const frame = stack.at(-1);
      if (!frame?.keys) continue;
      if (token === ",") frame.expectingKey = true;
      else if (token === ":") frame.expectingKey = false;
      else if (frame.expectingKey && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (frame.keys.has(key)) {
          const { line, column } = textPosition(text, match.index);
          throw invalidInput(`${flag} has a duplicate key.`, [
            inputIssue(
              flag,
              "invalid_json",
              `line ${line}, column ${column}: duplicate key ${echo(key)}.`,
            ),
          ]);
        }
        frame.keys.add(key);
      }
    }
  }
  return result;
}

export function createInputReader(dependencies: {
  cwd: string;
  localPath?: (source: string) => string;
  readInput?: (source: string) => Promise<string>;
}): CommandInputReader {
  const localPath =
    dependencies.localPath ??
    ((source: string) => path.resolve(dependencies.cwd, source));
  let stdinRead = false;
  // `source` is the path as the caller wrote it; every failure names it and
  // the flag that gave it.
  const text = async (source: string, flag = "--file"): Promise<string> => {
    const label = source === "-" ? "stdin" : source;
    const unreadable = (reason: string) =>
      invalidInput(`The ${flag} path could not be read.`, [
        inputIssue(flag, "unreadable", `${label}: ${reason}.`),
      ]);
    if (!source || source.includes("\0"))
      throw invalidFlag(
        flag,
        "invalid_value",
        `expected a file path or - for stdin; got ${echo(source)}.`,
      );
    if (source === "-") {
      if (stdinRead) throw stdinTwice(flag);
      stdinRead = true;
    }
    const filename = source === "-" ? "-" : localPath(source);
    const tooLarge = () => unreadable(`larger than ${mebibytes(byteLimit)}`);
    try {
      if (dependencies.readInput) {
        const result = await dependencies.readInput(filename);
        if (Buffer.byteLength(result) > byteLimit) throw tooLarge();
        return result;
      }
      let handle;
      if (filename !== "-") {
        handle = await open(filename, "r");
        try {
          const stat = await handle.stat();
          if (stat.isDirectory()) throw unreadable("is a directory");
          if (!stat.isFile()) throw unreadable("not an ordinary file");
          if (stat.size > byteLimit) throw tooLarge();
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      const stream = handle ? handle.createReadStream() : process.stdin;
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const part of stream) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += chunk.length;
          if (size > byteLimit) throw tooLarge();
          chunks.push(chunk);
        }
      } finally {
        if (handle) {
          stream.destroy();
          await handle.close();
        }
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.concat(chunks));
      } catch {
        throw unreadable("not UTF-8");
      }
      // A leading byte-order mark names the encoding; it is not text, and a
      // JSON value that keeps it fails to parse.
      return decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (fileSystemError(error)) throw fileFailure(error, flag, label);
      throw unreadable("could not be read");
    }
  };
  return {
    cwd: dependencies.cwd,
    localPath,
    text,
    json: async (source, flag = "--file") =>
      parseJsonValue(await text(source, flag), flag),
  };
}

export async function bodySource(
  args: CommandArguments,
  reader: CommandInputReader,
  required = true,
  [inlineFlag, fileFlag]: readonly [string, string] = ["--content", "--file"],
): Promise<string | undefined> {
  const content = option(args, inlineFlag);
  const file = option(args, fileFlag);
  if (content !== undefined && file !== undefined)
    throw conflictingFlags([inlineFlag, fileFlag]);
  if (content !== undefined) return content;
  if (file !== undefined) return reader.text(file, fileFlag);
  if (required) throw missingFlag([inlineFlag, fileFlag]);
  return undefined;
}
/** Markdown bodies decode \n, \t and \\ in inline --content outside code; files stay literal. */
export async function markdownBodySource(
  args: CommandArguments,
  reader: CommandInputReader,
  required = true,
  flags: readonly [string, string] = ["--content", "--file"],
): Promise<string | undefined> {
  const body = await bodySource(args, reader, required, flags);
  return body !== undefined && option(args, flags[0]) !== undefined
    ? decodeInlineEscapes(body)
    : body;
}
export async function jsonSource(
  args: CommandArguments,
  reader: CommandInputReader,
  inlineFlag: string,
  fileFlag: string,
): Promise<unknown> {
  const inline = option(args, inlineFlag);
  const file = option(args, fileFlag);
  if (inline !== undefined && file !== undefined)
    throw conflictingFlags([inlineFlag, fileFlag]);
  return inline !== undefined
    ? parseJsonValue(inline, inlineFlag, fileFlag)
    : file !== undefined
      ? reader.json(file, fileFlag)
      : undefined;
}
export function targetFromFlags(
  args: CommandArguments,
  allowedTypes: readonly string[],
): Pick<NormalizedCommandInput, "target"> {
  const found = allowedTypes.flatMap((type) => {
    const id = option(args, `--${type}`);
    return id === undefined ? [] : [{ type, id }];
  });
  if (found.length > 1)
    throw conflictingFlags(found.map(({ type }) => `--${type}`));
  const target = found[0];
  if (!target) return {};
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(target.id) ||
    (target.type !== "inbox" &&
      /^(?:room|thread|task|meta|taskmeta):/u.test(target.id))
  )
    throw invalidFlag(
      `--${target.type}`,
      "invalid_format",
      `expected a bare resource ID without a room:, thread: or task: prefix; got ${echo(target.id)}.`,
    );
  // A target names a resource inside the configured caller Context; it never
  // replaces that Context.
  return { target };
}
