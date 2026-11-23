import { generationCommandDefinitions } from "./connector-generation.js";
import { figmaCommandDefinitions } from "./connector-figma.js";
import { githubCommandDefinitions } from "./connector-github.js";
import { driveCommandDefinitions } from "./connector-drive.js";
import { notionCommandDefinitions } from "./connector-notion.js";
import { slackCommandDefinitions } from "./connector-slack.js";
import type {
  CommandDefinition,
  CommandArguments,
  CommandOption,
  CommandTarget,
} from "./command-definition.js";
import {
  createInputReader,
  option,
  parseArguments,
  targetFromFlags,
} from "./command-input.js";
import { messageCommandDefinitions } from "./message-commands.js";
import { documentCommandDefinitions } from "./document-commands.js";
import { documentImageCommandDefinitions } from "./document-image-commands.js";
import { businessCommandDefinitions } from "./business-commands.js";
import { mailCommandDefinitions } from "./connector-mail.js";
import { gmailCanvasCommandDefinitions } from "./connector-gmail-canvas.js";
import { calendarCommandDefinitions } from "./connector-calendar.js";
import { outlookCalendarCommandDefinitions } from "./connector-outlook-calendar.js";
import { webCommandDefinitions } from "./web-commands.js";
import { publicBusinessSchemas } from "./business-schemas.js";
import { CliError } from "./errors.js";

export const commandDefinitions: readonly CommandDefinition[] = [
  ...messageCommandDefinitions,
  ...documentCommandDefinitions,
  ...documentImageCommandDefinitions,
  ...businessCommandDefinitions,
  ...mailCommandDefinitions,
  ...gmailCanvasCommandDefinitions,
  ...figmaCommandDefinitions,
  ...githubCommandDefinitions,
  ...generationCommandDefinitions,
  ...driveCommandDefinitions,
  ...notionCommandDefinitions,
  ...slackCommandDefinitions,
  ...calendarCommandDefinitions,
  ...outlookCalendarCommandDefinitions,
  ...webCommandDefinitions,
];
export interface DomainCommand {
  readonly route: "commands" | "schema" | "help";
  readonly body: Record<string, unknown>;
  readonly json: boolean;
  readonly descriptor: CommandDefinition;
  readonly arguments: CommandArguments;
  readonly target?: CommandTarget;
  readonly scope?: { kind: string; id: string };
  readonly toolName?: string;
}
export function findCommand(
  args: readonly string[],
): CommandDefinition | undefined {
  return [...commandDefinitions]
    .sort((a, b) => b.command.length - a.command.length)
    .find(({ command }) =>
      command.every((part, index) => args[index] === part),
    );
}
/** An unknown command, listing the commands of the group it starts with. */
export function unknownCommand(args: readonly string[]): CliError {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  const words = args.slice(0, end < 0 ? args.length : end);
  for (let depth = words.length; depth > 0; depth--) {
    const group = words.slice(0, depth);
    const next = [
      ...new Set(
        commandDefinitions
          .filter(
            ({ command }) =>
              command.length > depth &&
              group.every((part, index) => command[index] === part),
          )
          .map(({ command }) => command[depth]!),
      ),
    ];
    if (next.length)
      return new CliError("usage", `Unknown command "${words.join(" ")}".`, {
        group: group.join(" "),
        commands: next,
      });
  }
  return new CliError(
    "usage",
    `Unknown command "${words.join(" ")}". Run teamhub --help for the command list.`,
  );
}
export function isDomainCommand(args: readonly string[]): boolean {
  return findCommand(args) !== undefined;
}
export function commandOptions(command: CommandDefinition) {
  return {
    ...command.options,
    "--json": { description: "Return machine-readable JSON.", boolean: true },
    "--help": {
      description: "Show this offline command reference.",
      boolean: true,
    },
    "-h": { description: "Show help.", boolean: true },
    ...(command.schema === false ||
    (command.fileRoute && command.schema !== true)
      ? {}
      : {
          "--schema": {
            description: "Show offline input and output schemas.",
            boolean: true,
          },
        }),
    ...(!(command.command[0] === "message" && command.readOnly) &&
    !command.fileRoute &&
    command.operationId !== false
      ? {
          "--operation-id": {
            description: "Stable operation identity for recovery.",
          },
        }
      : {}),
  };
}
export function domainHelp(prefix: readonly string[] = []): string {
  const matches = commandDefinitions.filter(({ command }) =>
    prefix.every((part, index) => command[index] === part),
  );
  if (!matches.length) return "";
  if (!prefix.length)
    return (
      "Usage: teamhub <command> [flags]\n\nCommands:\n" +
      [...new Set(commandDefinitions.map((item) => item.command[0]))]
        .sort()
        .map((name) => `  ${name}`)
        .concat("  help")
        .join("\n") +
      "\n\nRun teamhub <command> --help for command options. Help and schema are offline; TeamHub checks current resource access.\n"
    );
  if (
    matches.length > 1 &&
    [
      "gmail",
      "outlook",
      "feishu-mail",
      "outlook-calendar",
      "slack",
      "gcal",
      "notion",
      "gdrive",
      "figma",
      "github",
      "fal",
      "higgsfield",
      "web",
    ].includes(prefix[0]!)
  ) {
    const children = new Map<string, string>();
    for (const item of matches) {
      const child = item.command[prefix.length];
      if (child && !children.has(child))
        children.set(
          child,
          item.command.length === prefix.length + 1
            ? item.description
            : `Show help for ${child} subcommands.`,
        );
    }
    return `${prefix.join(" ")} common operations.\n\nUSAGE\n  teamhub ${prefix.join(" ")} <command> [flags]\n\nCOMMANDS\n${[...children].map(([name, description]) => `  ${name.padEnd(18)} ${description}`).join("\n")}\n\nINHERITED FLAGS\n  -h, --help          Show help\n\nEXAMPLES\n  teamhub ${prefix.join(" ")} ${children.keys().next().value} --help\n`;
  }
  if (matches.length === 1 && matches[0]!.toolName.startsWith("connector_")) {
    const item = matches[0]!;
    const inherited = {
      "--help": "Show help.",
      "-h": "Show help.",
      "--json": "Print complete JSON instead of the default readable text.",
      "--schema":
        "Show offline input and output schemas without business arguments.",
      "--operation-id":
        "Stable identity for this operation; keep it when the outcome is unknown and do not blindly resend.",
    };
    const flags = Object.entries(commandOptions(item)).filter(
      ([name]) => !["--help", "-h"].includes(name),
    );
    return [
      item.description,
      "",
      "USAGE",
      ...item.usage.map((line) => `  ${line}`),
      `  teamhub ${item.command.join(" ")} --schema [--json]`,
      "",
      ...(item.arguments?.length
        ? ["ARGUMENTS", ...item.arguments.map((line) => `  ${line}`), ""]
        : []),
      "FLAGS",
      ...flags.map(
        ([name, value]) =>
          `  ${(name + ("boolean" in value && value.boolean ? "" : " <value>")).padEnd(29)} ${(inherited as Record<string, string>)[name] ?? value.description}`,
      ),
      "",
      "INHERITED FLAGS",
      "  -h, --help                   Show help.",
      "",
      "OUTPUT",
      `  Shows the actual account, plus ${item.outputDescription ?? "the operation result and receipt."}`,
      ...(item.notes?.length ? ["", ...item.notes] : []),
      ...(item.examples?.length
        ? ["", "EXAMPLES", ...item.examples.map((line) => `  ${line}`)]
        : []),
      "",
      "LEARN MORE",
      `  teamhub ${item.command.slice(0, -1).join(" ")} --help`,
      `  teamhub ${item.command.join(" ")} --schema --json`,
      "",
    ].join("\n");
  }
  return (
    matches
      .map((item) =>
        [
          ...item.usage.map((usage) =>
            usage.startsWith("teamhub ")
              ? usage
              : `teamhub ${item.command.join(" ")} ${usage}`,
          ),
          item.description,
          "",
          ...(item.arguments?.length
            ? [
                "Arguments:",
                ...item.arguments.map((argument) => `  ${argument}`),
                "",
              ]
            : []),
          "Options:",
          ...Object.entries(commandOptions(item)).map(
            ([name, value]) =>
              `  ${name}${"boolean" in value && value.boolean ? "" : " <value>"}  ${value.description}`,
          ),
          ...(item.notes ?? []),
          ...(item.examples?.length ? ["Examples:", ...item.examples] : []),
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}
/** Help for a prefix. One command's help also lists its JSON flags' fields. */
export async function helpText(prefix: readonly string[]): Promise<string> {
  const help = domainHelp(prefix);
  const item = commandDefinitions.find(
    ({ command }) =>
      command.length === prefix.length &&
      command.every((part, index) => prefix[index] === part),
  );
  const flags = item
    ? Object.entries(item.options).filter(
        ([, value]) => value.json !== undefined,
      )
    : [];
  if (!help || !item || !flags.length) return help;
  const [{ input_schema }, { jsonFieldLines }] = await Promise.all([
    commandSchema(item),
    import("./command-help-fields.js"),
  ]);
  const sections = flags.flatMap(([name, value]) => {
    const lines = jsonFieldLines(input_schema, value.json!);
    const twin = `${name}-file`;
    return lines.length
      ? [
          "",
          `JSON fields of ${name}${Object.hasOwn(item.options, twin) ? ` and ${twin}` : ""}:`,
          ...lines,
        ]
      : [];
  });
  return sections.length ? `${help.trimEnd()}\n${sections.join("\n")}\n` : help;
}
export async function parseDomainCommand(
  args: readonly string[],
  dependencies: {
    cwd: string;
    localPath?: (source: string) => string;
    readInput?: (source: string) => Promise<string>;
    beforeNormalize?: (target?: CommandTarget) => void;
    syntaxOnly?: boolean;
  },
): Promise<DomainCommand> {
  const selected = findCommand(args);
  if (!selected) throw unknownCommand(args);
  const parsed = parseArguments(
    args.slice(selected.command.length),
    commandOptions(selected),
  );
  const json = option(parsed, "--json") !== undefined;
  const base = { json, descriptor: selected, arguments: parsed };
  if (option(parsed, "--help") || option(parsed, "-h"))
    return { ...base, route: "help", body: {} };
  if (option(parsed, "--schema")) {
    if (
      parsed.positionals.length ||
      parsed.ordered.some((item) => !["--schema", "--json"].includes(item.name))
    )
      throw new CliError(
        "usage",
        "Use --schema without business arguments or --operation-id.",
      );
    return { ...base, route: "schema", body: {} };
  }
  const selectedTarget = targetFromFlags(
    parsed,
    ["thread", "inbox"].filter(
      (type) => !selected.options[`--${type}`]?.repeatable,
    ),
  );
  const attempted = selectedTarget.target;
  dependencies.beforeNormalize?.(attempted);
  if (dependencies.syntaxOnly)
    return { ...base, route: "commands", target: attempted, body: {} };
  const reader = createInputReader(dependencies);
  const normalized = await selected.normalize(parsed, reader);
  const operationId = option(parsed, "--operation-id");
  if (
    operationId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
  )
    throw new CliError(
      "usage",
      "--operation-id requires 1-128 letters, digits, dots, underscores, colons or hyphens, beginning with a letter or digit.",
    );
  return {
    ...base,
    ...normalized,
    route: "commands",
    body: {
      command: selected.command,
      input: normalized.input,
      ...(operationId ? { operation_id: operationId } : {}),
    },
  };
}
/**
 * The schema as callers read it: English descriptions only, no pattern where
 * a format already names the shape, and required before properties so a
 * truncated read still shows which fields are required.
 */
function presentedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentedSchema);
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(
        ([key, item]) =>
          (key !== "description" ||
            typeof item !== "string" ||
            !/\p{Script=Han}/u.test(item)) &&
          (key !== "pattern" || !("format" in value)),
      )
      .map(([key, item]) => [key, presentedSchema(item)] as const);
    const properties = entries.findIndex(([key]) => key === "properties");
    const required = entries.findIndex(([key]) => key === "required");
    if (properties >= 0 && required > properties)
      entries.splice(properties, 0, ...entries.splice(required, 1));
    return Object.fromEntries(entries);
  }
  return value;
}
/**
 * Offline schema of one command. A definition's own schemas win; otherwise only
 * this command's business zod and the JSON Schema converter are loaded.
 */
export async function commandSchema(
  item: CommandDefinition,
): Promise<Record<string, unknown>> {
  let business: { input_schema?: object; output_schema?: object } = {};
  if (!item.inputSchema || !item.outputSchema) {
    const [{ loadAgentCommandSchema }, { toolSchemaToJsonSchema }] =
      await Promise.all([
        import("./command-schema-loader.js"),
        import("./domain-support/schema.js"),
      ]);
    const schema = await loadAgentCommandSchema(item.toolName);
    if (schema)
      business = {
        input_schema: toolSchemaToJsonSchema(schema.input, "input"),
        output_schema: toolSchemaToJsonSchema(schema.output, "output"),
      };
  }
  const publicSchemas = publicBusinessSchemas(item.toolName, business);
  return {
    command: item.command,
    description: item.description,
    read_only: item.readOnly,
    input_schema: presentedSchema(
      item.inputSchema ?? publicSchemas.input_schema,
    ),
    output_schema: presentedSchema(
      item.outputSchema ?? publicSchemas.output_schema,
    ),
    cli: {
      usage: item.usage,
      arguments: item.arguments ?? [],
      // `json` only tells help which flag carries the JSON fields.
      options: Object.fromEntries(
        Object.entries(
          commandOptions(item) as Record<string, CommandOption>,
        ).map(([name, { json: _json, ...option }]) => [name, option]),
      ),
      notes: item.notes ?? [],
    },
  };
}
