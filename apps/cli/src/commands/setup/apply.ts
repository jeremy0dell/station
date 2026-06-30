import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  runExternalCommand,
} from "@station/runtime";
import type { SetupAction, SetupPlan } from "./model.js";

export type SetupApplyFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  access(path: string): Promise<void>;
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
};

export type ApplySetupPlanResult = {
  plan: SetupPlan;
  failedAction?: SetupAction;
};

export async function applySetupPlan(
  plan: SetupPlan,
  options: ApplySetupPlanOptions = {},
): Promise<ApplySetupPlanResult> {
  const actions: SetupAction[] = [];
  const fs = options.fs ?? nodeApplyFs();
  for (const action of plan.actions) {
    if (!action.selected || options.actionFilter?.(action) === false) {
      actions.push({ ...action, status: "skipped" });
      continue;
    }
    if (options.dryRun === true) {
      actions.push({ ...action, status: "skipped" });
      continue;
    }
    try {
      const context: {
        fs: SetupApplyFileSystem;
        runner?: ExternalCommandRunner;
        env?: Record<string, string>;
        now?: () => Date;
        showCommandOutput?: boolean;
      } = {
        fs,
      };
      if (options.runner !== undefined) context.runner = options.runner;
      if (options.env !== undefined) context.env = options.env;
      if (options.now !== undefined) context.now = options.now;
      if (options.showCommandOutput !== undefined) {
        context.showCommandOutput = options.showCommandOutput;
      }
      await options.onActionStart?.(action);
      await applyAction(action, context);
      await options.onActionComplete?.(action);
      actions.push({ ...action, status: "completed" });
    } catch {
      const failed = { ...action, status: "failed" as const };
      await options.onActionFailed?.(failed);
      actions.push(failed);
      return {
        plan: { ...plan, actions: [...actions, ...remainingSkipped(plan.actions, actions.length)] },
        failedAction: failed,
      };
    }
  }
  return { plan: { ...plan, actions } };
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
  };
}
