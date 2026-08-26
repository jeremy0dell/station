import { doctorProject, loadConfig, type ProjectConfig, type StationConfig } from "@station/config";
import type {
  AcceptedCommandReceipt,
  CliRunAuditMetadata,
  FailedCommandRecord,
  RejectedCommandReceipt,
  SafeError,
  StationCommand,
  SucceededCommandRecord,
} from "@station/contracts";
import { allowlistedCliRunAuditMetadata } from "@station/observability";
import { parsePositiveIntegerOption, parseRequiredOptionValue } from "../args.js";
import type { ObserverProcessDeps } from "../observerProcess.js";
import {
  commandExecutionAuditMetadata,
  executeTypedObserverCommand,
  type TypedObserverCommandOptions,
} from "./command.js";

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

type ProjectMutationCommand = Extract<StationCommand, { type: "project.add" | "project.remove" }>;

export type ProjectCommandResult =
  | {
      action: "list";
      projects: ProjectSummary[];
    }
  | {
      action: "add" | "remove";
      status: "succeeded";
      receipt: AcceptedCommandReceipt;
      command: SucceededCommandRecord<ProjectMutationCommand>;
      projects: ProjectSummary[];
    }
  | {
      action: "add" | "remove";
      status: "failed";
      receipt: AcceptedCommandReceipt;
      command: FailedCommandRecord<ProjectMutationCommand>;
      projects: ProjectSummary[];
    }
  | {
      action: "add" | "remove";
      status: "rejected";
      receipt: RejectedCommandReceipt;
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

/**
 * ADAPTER
 *
 * Translates project CLI intent into configuration reads or typed Observer project commands.
 */
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
  const executionOptions = projectExecutionOptions(options, timeoutMs);
  const outcome = await executeTypedObserverCommand(command, executionOptions, deps);
  if (outcome.status === "accepted") throw missingProjectCompletionError(outcome.receipt.commandId);
  const loaded =
    options.configPath === undefined
      ? await loadConfig()
      : await loadConfig({ configPath: options.configPath });
  const projects = summarizeProjects(loaded.projects);
  if (outcome.status === "rejected") {
    return {
      action: parsed.action,
      status: "rejected",
      receipt: outcome.receipt,
      projects,
    };
  }
  if (outcome.status === "succeeded") {
    return {
      action: parsed.action,
      status: "succeeded",
      receipt: outcome.receipt,
      command: outcome.record,
      projects,
    };
  }
  return {
    action: parsed.action,
    status: "failed",
    receipt: outcome.receipt,
    command: outcome.record,
    projects,
  };
}

export function projectCommandExitCode(result: ProjectCommandResult): number {
  if (
    (result.action === "add" || result.action === "remove") &&
    (result.status === "rejected" || result.status === "failed")
  ) {
    return 1;
  }
  if (result.action === "doctor" && result.status === "warn") {
    return 1;
  }
  return 0;
}

export function projectCommandAuditMetadata(result: ProjectCommandResult): CliRunAuditMetadata {
  if (result.action === "list") {
    return {
      collection: {
        resource: "projects",
        count: result.projects.length,
        identifiersOmitted: true,
      },
    };
  }
  if (result.action === "doctor") {
    return allowlistedCliRunAuditMetadata({ resources: { projectId: result.project.id } }) ?? {};
  }
  const audit = commandExecutionAuditMetadata({
    status: result.status,
    receipt: result.receipt,
    ...(result.status === "succeeded" || result.status === "failed"
      ? { record: result.command }
      : {}),
  });
  if (result.action === "add" && result.status === "succeeded") {
    const command = result.command.command;
    if (command.type !== "project.add") return audit;
    const added = result.projects.find((project) => project.root === command.payload.path);
    if (added !== undefined) {
      return (
        allowlistedCliRunAuditMetadata({
          ...audit,
          resources: { ...audit.resources, projectId: added.id },
        }) ?? audit
      );
    }
  }
  return audit;
}

function projectExecutionOptions(
  options: ProjectCommandOptions,
  timeoutMs: number,
): TypedObserverCommandOptions {
  const executionOptions: TypedObserverCommandOptions = {
    timeoutMs,
    waitForCompletion: true,
  };
  if (options.config !== undefined) executionOptions.config = options.config;
  if (options.configPath !== undefined) executionOptions.configPath = options.configPath;
  return executionOptions;
}

function missingProjectCompletionError(commandId: string): SafeError {
  return {
    tag: "ProjectCliError",
    code: "PROJECT_COMMAND_COMPLETION_MISSING",
    message: "The project command returned before its durable completion was available.",
    commandId,
  };
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
): ProjectMutationCommand {
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
