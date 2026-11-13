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
  const words = shellWords(command);
  const start = words.findIndex(
    (word, index) =>
      (word === "teamhub" || word.endsWith("/teamhub")) &&
      words[index + 1] === "task",
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
  return {
    operation,
    ...(flags.has("--name") ? { name: flags.get("--name") } : {}),
    ...(flags.has("--message") ? { message: flags.get("--message") } : {}),
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
      else if (char === "\\" && quote === '"' && index + 1 < command.length)
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
