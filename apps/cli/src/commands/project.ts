import { doctorProject, loadConfig, type ProjectConfig, type StationConfig } from "@station/config";
import type { CommandReceipt, CommandRecord, StationCommand } from "@station/contracts";
import { parsePositiveIntegerOption, parseRequiredOptionValue } from "../args.js";
import type { ObserverProcessDeps } from "../observerProcess.js";
import { runCommandCommand } from "./command.js";

export type ProjectCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
};

export type ProjectSummary = {
  id: string;
  label: string;
  root: string;
};

export type ProjectCommandResult =
  | {
      action: "list";
      projects: ProjectSummary[];
    }
  | {
      action: "add" | "remove";
      status: "succeeded" | "failed";
      receipt: CommandReceipt;
      command: CommandRecord;
      projects: ProjectSummary[];
    }
  | {
      action: "doctor";
      project: ProjectSummary;
      status: "ok" | "warn";
      rootExists: boolean;
      gitRoot?: string;
      messages: string[];
    };

type ParsedProjectArgs =
  | {
      action: "list";
    }
  | {
      action: "add";
      path: string;
      id?: string;
      label?: string;
      allowNonGit: boolean;
      timeoutMs?: number;
    }
  | {
      action: "remove";
      projectId: string;
      timeoutMs?: number;
    }
  | {
      action: "doctor";
      projectId: string;
    };

export async function runProjectCommand(
  args: string[],
  options: ProjectCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ProjectCommandResult> {
  const parsed = parseProjectArgs(args);
  if (parsed.action === "list") {
    return {
      action: "list",
      projects: summarizeProjects(options.config?.projects ?? []),
    };
  }

  if (parsed.action === "doctor") {
    const project = findProject(options.config?.projects ?? [], parsed.projectId);
    const result = await doctorProject(project);
    return {
      action: "doctor",
      project: summarizeProject(project),
      status: result.status,
      rootExists: result.rootExists,
      ...(result.gitRoot === undefined ? {} : { gitRoot: result.gitRoot }),
      messages: result.messages,
    };
  }

  const command = commandForParsedArgs(parsed);
  const timeoutMs = parsed.timeoutMs ?? options.timeoutMs ?? 30_000;
  const dispatched = await runCommandCommand(
    ["dispatch", "--stdin", "--wait", "--timeout-ms", String(timeoutMs)],
    { ...options, stdin: JSON.stringify(command), timeoutMs },
    deps,
  );
  if (!("receipt" in dispatched) || !("command" in dispatched)) {
    throw new Error("Project command dispatch did not return a completed command record.");
  }
  const loaded =
    options.configPath === undefined
      ? await loadConfig()
      : await loadConfig({ configPath: options.configPath });
  return {
    action: parsed.action,
    status: dispatched.status,
    receipt: dispatched.receipt,
    command: dispatched.command,
    projects: summarizeProjects(loaded.projects),
  };
}

export function projectCommandExitCode(result: ProjectCommandResult): number {
  if ((result.action === "add" || result.action === "remove") && result.status === "failed") {
    return 1;
  }
  if (result.action === "doctor" && result.status === "warn") {
    return 1;
  }
  return 0;
}

function parseProjectArgs(args: string[]): ParsedProjectArgs {
  const action = args[0] ?? "list";
  if (action === "list") {
    if (args.length > 1) {
      throw new Error(`Unknown project list option: ${args[1] ?? ""}`);
    }
    return { action: "list" };
  }
  if (action === "add") {
    return parseAddArgs(args.slice(1));
  }
  if (action === "remove") {
    return parseRemoveArgs(args.slice(1));
  }
  if (action === "doctor") {
    return parseDoctorArgs(args.slice(1));
  }
  throw new Error(`Unknown project action: ${action}`);
}

function parseAddArgs(args: string[]): Extract<ParsedProjectArgs, { action: "add" }> {
  const path = args[0];
  if (path === undefined) {
    throw new Error("project add requires a path.");
  }
  const parsed: Extract<ParsedProjectArgs, { action: "add" }> = {
    action: "add",
    path,
    allowNonGit: false,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id") {
      parsed.id = parseRequiredOptionValue(args[index + 1], "--id");
      index += 1;
      continue;
    }
    if (arg === "--label") {
      parsed.label = parseRequiredOptionValue(args[index + 1], "--label");
      index += 1;
      continue;
    }
    if (arg === "--allow-non-git") {
      parsed.allowNonGit = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveIntegerOption(args[index + 1], "--timeout-ms");
      index += 1;
      continue;
    }
    throw new Error(`Unknown project add option: ${arg ?? ""}`);
  }

  return parsed;
}

function parseRemoveArgs(args: string[]): Extract<ParsedProjectArgs, { action: "remove" }> {
  const projectId = args[0];
  if (projectId === undefined) {
    throw new Error("project remove requires a project id.");
  }
  const parsed: Extract<ParsedProjectArgs, { action: "remove" }> = {
    action: "remove",
    projectId,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveIntegerOption(args[index + 1], "--timeout-ms");
      index += 1;
      continue;
    }
    throw new Error(`Unknown project remove option: ${arg ?? ""}`);
  }
  return parsed;
}

function parseDoctorArgs(args: string[]): Extract<ParsedProjectArgs, { action: "doctor" }> {
  const projectId = args[0];
  if (projectId === undefined) {
    throw new Error("project doctor requires a project id.");
  }
  if (args.length > 1) {
    throw new Error(`Unknown project doctor option: ${args[1] ?? ""}`);
  }
  return {
    action: "doctor",
    projectId,
  };
}

function commandForParsedArgs(
  parsed: Extract<ParsedProjectArgs, { action: "add" | "remove" }>,
): StationCommand {
  if (parsed.action === "remove") {
    return {
      type: "project.remove",
      payload: {
        projectId: parsed.projectId,
      },
    };
  }

  return {
    type: "project.add",
    payload: {
      path: parsed.path,
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(parsed.allowNonGit ? { allowNonGit: true } : {}),
    },
  };
}

function findProject(projects: readonly ProjectConfig[], projectId: string): ProjectConfig {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project !== undefined) {
    return project;
  }
  throw new Error(`Project "${projectId}" is not configured.`);
}

function summarizeProjects(projects: readonly ProjectConfig[]): ProjectSummary[] {
  return projects.map(summarizeProject);
}

function summarizeProject(project: ProjectConfig): ProjectSummary {
  return {
    id: project.id,
    label: project.label,
    root: project.root,
  };
}
