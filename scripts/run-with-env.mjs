#!/usr/bin/env node
// Runs a command with inline KEY=VALUE overrides without relying on POSIX
// shell assignment syntax, so package scripts work on Windows and Unix alike.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  process.stderr.write(
    "Usage: run-with-env.mjs KEY=VALUE ... -- <command> [args...]\n",
  );
  process.exit(2);
}

const env = { ...process.env };
for (const assignment of args.slice(0, separator)) {
  const equals = assignment.indexOf("=");
  if (equals <= 0) {
    process.stderr.write(`Invalid environment assignment: ${assignment}\n`);
    process.exit(2);
  }
  const key = assignment.slice(0, equals);
  const value = assignment.slice(equals + 1);
  env[key] =
    key === "NODE_OPTIONS" && env.NODE_OPTIONS
      ? `${env.NODE_OPTIONS} ${value}`
      : value;
}

const [command, ...commandArgs] = args.slice(separator + 1);
const resolvedCommand = command === "node" ? process.execPath : command;
const result = spawnSync(resolvedCommand, commandArgs, {
  env,
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
