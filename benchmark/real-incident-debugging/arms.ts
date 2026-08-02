import { relative, resolve, sep } from "node:path";
import type { Arm, CommandPattern, NeutralArmLabel, Replay } from "./protocol.js";

const shellMetacharacters = new Set([";", "&", "|", "<", ">", "`", "$"]);
const rawExecutables = new Set(["rg", "find", "sed", "tail", "sqlite3"]);

export type ArmAccess = {
  arm: Arm;
  blindArm: NeutralArmLabel;
  commandPatterns: CommandPattern[];
};

export type CommandPolicyResult = { ok: true; argv: string[] } | { ok: false; reason: string };

export function createArmAccess(input: {
  arm: Arm;
  blindArm: NeutralArmLabel;
  replay: Replay;
}): ArmAccess {
  return {
    arm: input.arm,
    blindArm: input.blindArm,
    commandPatterns: input.arm === "raw" ? input.replay.rawCommands : input.replay.stationCommands,
  };
}

export function parseRestrictedCommand(command: string): CommandPolicyResult {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (quote === '"' && (character === "$" || character === "`")) {
        return { ok: false, reason: "shell expansion is forbidden" };
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (shellMetacharacters.has(character) || character === "\n" || character === "\r") {
      return { ok: false, reason: "shell composition and expansion are forbidden" };
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping || quote !== undefined) {
    return { ok: false, reason: "unterminated shell token" };
  }
  if (current.length > 0) {
    argv.push(current);
  }
  if (argv.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  return { ok: true, argv };
}

export function validateCommand(input: {
  access: ArmAccess;
  argv: string[];
  workspaceRoot: string;
}): CommandPolicyResult {
  const [executable, ...arguments_] = input.argv;
  if (executable === undefined || !matchesAnyPattern(input.argv, input.access.commandPatterns)) {
    return { ok: false, reason: "command is not in this trial's allowlist" };
  }
  if (input.access.arm === "raw") {
    if (!rawExecutables.has(executable)) {
      return { ok: false, reason: "raw-evidence access permits only raw inspection tools" };
    }
    const rawCheck = validateRawInspection(executable, arguments_);
    if (rawCheck.ok === false) {
      return rawCheck;
    }
  } else if (executable !== "stn") {
    return { ok: false, reason: "Station arms permit only public stn commands" };
  }

  const pathCheck = validateWorkspaceArguments(arguments_, input.workspaceRoot);
  if (pathCheck.ok === false) {
    return pathCheck;
  }
  return { ok: true, argv: input.argv };
}

export function validateExecutedCommand(input: {
  access: ArmAccess;
  command: string;
  workspaceRoot: string;
}): CommandPolicyResult {
  const parsed = parseRestrictedCommand(input.command);
  if (parsed.ok === false) {
    return parsed;
  }
  const unwrapped = unwrapCodexShellCommand(parsed.argv);
  if (unwrapped.ok === false) {
    return unwrapped;
  }
  return validateCommand({
    access: input.access,
    argv: unwrapped.argv,
    workspaceRoot: input.workspaceRoot,
  });
}

function unwrapCodexShellCommand(argv: string[]): CommandPolicyResult {
  if (argv[0] !== "/bin/zsh" && argv[0] !== "/bin/bash" && argv[0] !== "/bin/sh") {
    return { ok: true, argv };
  }
  if (argv.length !== 3 || argv[1] !== "-lc" || argv[2] === undefined) {
    return { ok: false, reason: "unsupported shell wrapper" };
  }
  return parseRestrictedCommand(argv[2]);
}

function matchesAnyPattern(argv: string[], patterns: CommandPattern[]): boolean {
  return patterns.some((pattern) => {
    if (argv.length !== pattern.arguments.length + 1 || argv[0] !== pattern.executable) {
      return false;
    }
    return pattern.arguments.every((argument, index) => {
      const value = argv[index + 1];
      return value !== undefined && (argument === value || matchesPlaceholder(argument, value));
    });
  });
}

function matchesPlaceholder(pattern: string, value: string): boolean {
  if (!/^\{(?:id|traceId|commandId|diagnosticId|query|path|sql|number)\}$/u.test(pattern)) {
    return false;
  }
  return value.length > 0 && !/[\r\n]/u.test(value);
}

function validateRawInspection(executable: string, arguments_: string[]): CommandPolicyResult {
  switch (executable) {
    case "rg":
      if (arguments_.some((argument) => argument === "--pre" || argument.startsWith("--pre="))) {
        return { ok: false, reason: "rg --pre can execute arbitrary commands" };
      }
      return { ok: true, argv: [executable, ...arguments_] };
    case "find":
      if (
        arguments_.some((argument) =>
          [
            "-delete",
            "-exec",
            "-execdir",
            "-ok",
            "-okdir",
            "-fprint",
            "-fprint0",
            "-fprintf",
            "-fls",
          ].includes(argument),
        )
      ) {
        return { ok: false, reason: "mutating or command-executing find predicates are forbidden" };
      }
      return { ok: true, argv: [executable, ...arguments_] };
    case "sed":
      if (
        arguments_.length < 3 ||
        arguments_[0] !== "-n" ||
        !/^\d+(?:,\d+)?p$/u.test(arguments_[1] ?? "")
      ) {
        return { ok: false, reason: "sed is limited to numeric -n print ranges" };
      }
      return { ok: true, argv: [executable, ...arguments_] };
    case "tail":
      if (arguments_.some((argument) => argument === "-f" || argument === "--follow")) {
        return { ok: false, reason: "tail follow mode is forbidden" };
      }
      return { ok: true, argv: [executable, ...arguments_] };
    case "sqlite3":
      if (!arguments_.includes("-readonly")) {
        return { ok: false, reason: "sqlite3 must use -readonly" };
      }
      if (arguments_.some((argument) => argument === "-cmd" || argument.startsWith("-cmd="))) {
        return { ok: false, reason: "sqlite3 -cmd is forbidden" };
      }
      if (!isReadOnlySql(arguments_.at(-1) ?? "")) {
        return { ok: false, reason: "sqlite3 query is not read-only" };
      }
      return { ok: true, argv: [executable, ...arguments_] };
    default:
      return { ok: false, reason: "unsupported raw inspection executable" };
  }
}

function validateWorkspaceArguments(
  arguments_: string[],
  workspaceRoot: string,
): CommandPolicyResult {
  const workspace = resolve(workspaceRoot);
  for (const argument of arguments_) {
    if (argument === ".." || argument.startsWith(`..${sep}`)) {
      return { ok: false, reason: "parent-directory traversal is forbidden" };
    }
    if (argument.startsWith("/")) {
      const target = resolve(argument);
      const pathRelative = relative(workspace, target);
      if (
        pathRelative === ".." ||
        pathRelative.startsWith(`..${sep}`) ||
        pathRelative.startsWith("/")
      ) {
        return { ok: false, reason: "paths must stay inside the trial workspace" };
      }
    }
  }
  return { ok: true, argv: [] };
}

function isReadOnlySql(query: string): boolean {
  const normalized = query.trim().toUpperCase();
  if (normalized === ".TABLES" || normalized === ".SCHEMA") {
    return true;
  }
  if (normalized.includes(";")) {
    return false;
  }
  if (
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE)\b/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return /^(?:SELECT|PRAGMA|EXPLAIN|WITH)\b/u.test(normalized);
}
