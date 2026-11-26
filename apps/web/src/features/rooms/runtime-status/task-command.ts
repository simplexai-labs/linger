/**
 * A Meta's `teamhub task …` CLI call, read from the command it ran. The CLI
 * is our own program with fixed flags, so its argv is a structured record of
 * the Task operation, not prose.
 */
export interface TaskCommand {
  operation: "create" | "send" | "stop" | "check";
  /** The Task's title, from `task create --name` or an earlier step that created it. */
  name?: string;
  /** The message `task send` delivered. */
  message?: string;
  taskId?: string;
}

const OPERATIONS = new Set<TaskCommand["operation"]>([
  "create",
  "send",
  "stop",
  "check",
]);

export function parseTaskCommand(command: string): TaskCommand | undefined {
  const { line, body } = splitCommandBody(command);
  const words = shellWords(line);
  const start = words.findIndex(
    (word, index) => isTeamHubWord(word) && words[index + 1] === "task",
  );
  if (start < 0) return undefined;
  const operation = words[start + 2] as TaskCommand["operation"];
  if (!OPERATIONS.has(operation)) return undefined;
  const flags = new Map<string, string>();
  for (let index = start + 3; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "&&" || word === "|" || word === ";") break;
    if (!word.startsWith("--")) continue;
    const equals = word.indexOf("=");
    if (equals > 0) {
      flags.set(word.slice(0, equals), word.slice(equals + 1));
    } else if (
      index + 1 < words.length &&
      !words[index + 1]!.startsWith("--")
    ) {
      // A flag followed by another flag, such as --steer, takes no value.
      flags.set(word, words[index + 1]!);
      index += 1;
    }
  }
  const message =
    flags.get("--message") ??
    (flags.get("--message-file") === "-" ? body : undefined);
  return {
    operation,
    ...(flags.has("--name") ? { name: flags.get("--name") } : {}),
    ...(message === undefined ? {} : { message }),
    ...(flags.has("--task-id") ? { taskId: flags.get("--task-id") } : {}),
  };
}

/**
 * The Task a `task create` receipt names. The receipt is display text, so the
 * Task is found by TeamHub's ID format, never by the receipt's wording.
 */
export function createdTaskId(output: string | undefined) {
  return output?.match(/\bworkitem_[0-9a-f]{32}\b/)?.[0];
}

function isTeamHubWord(word: string): boolean {
  const base = word.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return base === "teamhub" || base === "teamhub.cmd" || base === "teamhub.exe";
}

function splitCommandBody(command: string): { line: string; body?: string } {
  const normalized = command.replace(/\r\n/g, "\n");
  return (
    splitPowerShellHereString(normalized) ?? splitQuotedHeredoc(normalized)
  );
}

/**
 * Separates a PowerShell single-quoted here-string (`@' ... '@ | <command>`)
 * from the piped command line so `--message-file -` reads its literal body.
 */
function splitPowerShellHereString(
  command: string,
): { line: string; body: string } | undefined {
  const open = /^[ \t\n]*@'[ \t]*\n/u.exec(command);
  if (!open) return undefined;
  const lines = command.slice(open[0].length).split("\n");
  const end = lines.findIndex((line) => line.startsWith("'@"));
  if (end < 0) return undefined;
  const closingLine = lines[end]!;
  const afterClose = [closingLine.slice(2), ...lines.slice(end + 1)].join("\n");
  const pipe = /^[ \t]*\|(?![|&])[ \t\n]*/u.exec(afterClose);
  if (!pipe) return undefined;
  return {
    body: lines.slice(0, end).join("\n"),
    line: afterClose.slice(pipe[0].length),
  };
}

/**
 * Separates a command from the body of its quoted heredoc (`<<'EOF'`), the
 * stdin a `--message-file -` reads. A quoted heredoc's body is literal, so it
 * is exactly the text the command received.
 */
function splitQuotedHeredoc(command: string): { line: string; body?: string } {
  const operator = /<<[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/u.exec(command);
  const start = operator ? command.indexOf("\n", operator.index) : -1;
  if (!operator || start < 0) return { line: command };
  const lines = command.slice(start + 1).split("\n");
  const end = lines.indexOf(operator[2]!);
  if (end < 0) return { line: command };
  return {
    line: command.slice(0, start),
    body: lines.slice(0, end).join("\n"),
  };
}

/** Splits a command line into words, honoring single and double quotes. */
function shellWords(command: string) {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (
        char === "\\" &&
        quote === '"' &&
        index + 1 < command.length &&
        '"\\$`'.includes(command[index + 1]!)
      )
        current += command[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}
