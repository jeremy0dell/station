import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type {
  SetupOperation,
  SetupOperationExecutor,
  SetupOperationOutcome,
} from "@station/setup-core";
import type { SetupAction, SetupPlan } from "./model.js";

export type SetupApplyFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  access(path: string): Promise<void>;
  rm?(path: string, options: { force: true }): Promise<void>;
};

export type SetupOperationBinding = {
  readonly actionId: string;
  readonly operation: SetupOperation;
};

export type ApplySetupPlanOptions = {
  runner?: ExternalCommandRunner;
  fs?: SetupApplyFileSystem;
  // Environment for spawned run-command/brew-install actions, merged over the
  // process env. Needed so a post-bootstrap `brew install` finds brew via the
  // freshly added brew prefix, which the current process PATH usually lacks.
  env?: Record<string, string>;
  dryRun?: boolean;
  now?: () => Date;
  actionFilter?: (action: SetupAction) => boolean;
  showCommandOutput?: boolean;
  onActionStart?: (action: SetupAction) => void | Promise<void>;
  onActionComplete?: (action: SetupAction) => void | Promise<void>;
  onActionFailed?: (action: SetupAction) => void | Promise<void>;
  operationBindings?: readonly SetupOperationBinding[];
  executeOperation?: SetupOperationExecutor;
};

export type ApplySetupPlanResult = {
  plan: SetupPlan;
  failedAction?: SetupAction;
  failedOperation?: Extract<SetupOperationOutcome, { status: "failed" }>;
  operationOutcomes: readonly SetupOperationOutcome[];
};

export async function applySetupPlan(
  plan: SetupPlan,
  options: ApplySetupPlanOptions = {},
): Promise<ApplySetupPlanResult> {
  const actions: SetupAction[] = [];
  const operationOutcomes: SetupOperationOutcome[] = [];
  const bindings = new Map(
    options.operationBindings?.map((binding) => [binding.actionId, binding] as const) ?? [],
  );
  const fs = options.fs ?? nodeApplyFs();
  let failedAction: SetupAction | undefined;
  let failedOperation: Extract<SetupOperationOutcome, { status: "failed" }> | undefined;
  for (const action of plan.actions) {
    if (!action.selected || options.actionFilter?.(action) === false) {
      actions.push({ ...action, status: "skipped" });
      continue;
    }
    if (options.dryRun === true) {
      actions.push({ ...action, status: "skipped" });
      continue;
    }
    const binding = bindings.get(action.id);
    await options.onActionStart?.(action);
    if (
      binding !== undefined &&
      options.executeOperation !== undefined &&
      action.id !== "mkdir-config-dir"
    ) {
      const outcome = await options.executeOperation(binding.operation);
      operationOutcomes.push(outcome);
      if (outcome.status === "completed") {
        const completed = completedAction(action, outcome);
        await options.onActionComplete?.(completed);
        actions.push(completed);
        continue;
      }

      const failed = { ...action, status: "failed" as const };
      failedAction ??= failed;
      failedOperation ??= outcome;
      await options.onActionFailed?.(failed);
      actions.push(failed);
      if (
        binding.operation.kind === "prepare-harness-tracking" ||
        binding.operation.kind === "prepare-worktrunk-tracking"
      ) {
        continue;
      }
      return applyResult(plan, actions, operationOutcomes, failedAction, failedOperation, true);
    }

    try {
      if (binding === undefined || action.id !== "mkdir-config-dir") {
        const context: {
          fs: SetupApplyFileSystem;
          runner?: ExternalCommandRunner;
          env?: Record<string, string>;
          now?: () => Date;
          showCommandOutput?: boolean;
        } = { fs };
        if (options.runner !== undefined) context.runner = options.runner;
        if (options.env !== undefined) context.env = options.env;
        if (options.now !== undefined) context.now = options.now;
        if (options.showCommandOutput !== undefined) {
          context.showCommandOutput = options.showCommandOutput;
        }
        await applyAction(action, context);
      }
      const completed = { ...action, status: "completed" as const };
      await options.onActionComplete?.(completed);
      actions.push(completed);
    } catch {
      const failed = { ...action, status: "failed" as const };
      failedAction ??= failed;
      await options.onActionFailed?.(failed);
      actions.push(failed);
      return applyResult(plan, actions, operationOutcomes, failedAction, failedOperation, true);
    }
  }
  return applyResult(plan, actions, operationOutcomes, failedAction, failedOperation, false);
}

function completedAction(action: SetupAction, outcome: SetupOperationOutcome): SetupAction {
  if (
    outcome.status === "completed" &&
    outcome.commit.kind === "config" &&
    outcome.commit.backupPath !== undefined
  ) {
    return {
      ...action,
      status: "completed",
      data: { ...(action.data ?? {}), backupPath: outcome.commit.backupPath },
    };
  }
  return { ...action, status: "completed" };
}

function applyResult(
  plan: SetupPlan,
  actions: readonly SetupAction[],
  operationOutcomes: readonly SetupOperationOutcome[],
  failedAction: SetupAction | undefined,
  failedOperation: Extract<SetupOperationOutcome, { status: "failed" }> | undefined,
  skipRemaining: boolean,
): ApplySetupPlanResult {
  const projectedActions = skipRemaining
    ? [...actions, ...remainingSkipped(plan.actions, actions.length)]
    : [...actions];
  const result: {
    plan: SetupPlan;
    operationOutcomes: readonly SetupOperationOutcome[];
    failedAction?: SetupAction;
    failedOperation?: Extract<SetupOperationOutcome, { status: "failed" }>;
  } = {
    plan: { ...plan, actions: projectedActions },
    operationOutcomes,
  };
  if (failedAction !== undefined) result.failedAction = failedAction;
  if (failedOperation !== undefined) result.failedOperation = failedOperation;
  return result;
}

async function applyAction(
  action: SetupAction,
  options: {
    fs: SetupApplyFileSystem;
    runner?: ExternalCommandRunner;
    now?: () => Date;
    showCommandOutput?: boolean;
  },
): Promise<void> {
  switch (action.kind) {
    case "brew-install":
    case "run-command":
      await runActionCommand(action, options);
      return;
    case "mkdir":
      if (action.path === undefined) throw new Error("mkdir action requires path.");
      await options.fs.mkdir(dirname(action.path), { recursive: true });
      return;
    case "write-config":
      await writeConfigAction(action, options);
      return;
    case "append-file":
      await appendFileAction(action, options);
      return;
    case "noop":
      return;
  }
}

async function runActionCommand(
  action: SetupAction,
  options: {
    runner?: ExternalCommandRunner;
    env?: Record<string, string>;
    showCommandOutput?: boolean;
  },
) {
  const command = action.command;
  if (command === undefined || command.length === 0) {
    throw new Error(`${action.id} action requires a command.`);
  }
  const [binary, ...args] = command;
  if (binary === undefined) {
    throw new Error(`${action.id} action requires a command.`);
  }
  const input: ExternalCommandInput = { command: binary, args, maxOutputChars: 4096 };
  if (options.env !== undefined) input.env = options.env;
  if (options.showCommandOutput === true) input.stdio = "inherit";
  await runExternalCommand(input, options.runner);
}

async function writeConfigAction(
  action: SetupAction,
  options: { fs: SetupApplyFileSystem; now?: () => Date },
): Promise<void> {
  const path = action.path;
  const content = action.data?.content;
  if (path === undefined || content === undefined) {
    throw new Error("write-config action requires path and content.");
  }
  const backupPath = await writeFileAtomically(path, content, options);
  if (backupPath !== undefined) {
    action.data = { ...(action.data ?? {}), backupPath };
  }
}

async function appendFileAction(
  action: SetupAction,
  options: { fs: SetupApplyFileSystem; now?: () => Date },
): Promise<void> {
  const path = action.path;
  const appendedText = action.data?.appendedText;
  const marker = action.data?.marker;
  const endMarker = action.data?.endMarker;
  if (path === undefined || appendedText === undefined) {
    throw new Error("append-file action requires path and appendedText.");
  }
  let existing = "";
  try {
    existing = await options.fs.readFile(path);
  } catch {
    existing = "";
  }
  if (marker !== undefined && existing.includes(marker)) {
    const replaced = replaceMarkedBlock(existing, marker, endMarker, appendedText);
    if (replaced === undefined || replaced === existing) {
      return;
    }
    const backupPath = await writeFileAtomically(path, replaced, options);
    if (backupPath !== undefined) {
      action.data = { ...(action.data ?? {}), backupPath };
    }
    return;
  }
  const nextContent =
    existing.trim().length === 0
      ? ensureTrailingNewline(appendedText)
      : `${existing.trimEnd()}\n\n${ensureTrailingNewline(appendedText)}`;
  const backupPath = await writeFileAtomically(path, nextContent, options);
  if (backupPath !== undefined) {
    action.data = { ...(action.data ?? {}), backupPath };
  }
}

async function writeFileAtomically(
  path: string,
  content: string,
  options: { fs: SetupApplyFileSystem; now?: () => Date },
): Promise<string | undefined> {
  await options.fs.mkdir(dirname(path), { recursive: true });
  const backupPath = await backupExistingConfig(path, options);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await options.fs.writeFile(tempPath, content);
  await options.fs.rename(tempPath, path);
  return backupPath;
}

async function backupExistingConfig(
  path: string,
  options: { fs: SetupApplyFileSystem; now?: () => Date },
): Promise<string | undefined> {
  try {
    await options.fs.access(path);
  } catch {
    return undefined;
  }
  const content = await options.fs.readFile(path);
  const stamp = (options.now ?? (() => new Date()))().toISOString().replaceAll(/[:.]/g, "-");
  const backupPath = `${path}.${stamp}.bak`;
  await options.fs.writeFile(backupPath, content);
  return backupPath;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function replaceMarkedBlock(
  existing: string,
  marker: string,
  endMarker: string | undefined,
  appendedText: string,
): string | undefined {
  if (endMarker === undefined) {
    return undefined;
  }
  const start = existing.indexOf(marker);
  if (start === -1) {
    return undefined;
  }
  const end = existing.indexOf(endMarker, start + marker.length);
  if (end === -1) {
    return undefined;
  }
  const endLineIndex = existing.indexOf("\n", end + endMarker.length);
  const blockEnd = endLineIndex === -1 ? existing.length : endLineIndex + 1;
  const currentBlock = existing.slice(start, blockEnd).trimEnd();
  const nextBlock = ensureTrailingNewline(appendedText).trimEnd();
  if (currentBlock === nextBlock) {
    return existing;
  }
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(blockEnd).trimStart();
  const parts = [before, nextBlock, after].filter((part) => part.length > 0);
  return `${parts.join("\n\n")}\n`;
}

function remainingSkipped(actions: readonly SetupAction[], completedCount: number): SetupAction[] {
  return actions.slice(completedCount).map((action) => ({ ...action, status: "skipped" }));
}

function nodeApplyFs(): SetupApplyFileSystem {
  return {
    async mkdir(path, options) {
      await mkdir(path, options);
    },
    async readFile(path) {
      return readFile(path, "utf8");
    },
    async writeFile(path, content) {
      await writeFile(path, content, "utf8");
    },
    rename,
    access,
    rm,
  };
}
