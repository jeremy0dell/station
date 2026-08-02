import { isCompiledBinary } from "@station/runtime";
import type { SetupToolInstallOperation } from "@station/setup-core";
import { resolveSetupMessage, setupMessageRef } from "@station/setup-messages";
import type { CliEnv } from "../../env.js";
import { createSetupOperationAdapter } from "./adapters/operations.js";
import { checkBrewDependency } from "./checks/brew.js";
import { checkSetupBun } from "./checks/bun.js";
import { checkSetupDiffnav } from "./checks/diffnav.js";
import { checkSetupGitDelta } from "./checks/gitDelta.js";
import type { SetupDependencyCheckOptions } from "./checks/system.js";
import { checkSetupTmux } from "./checks/tmux.js";
import { checkSetupToolchain, type ToolchainFact } from "./checks/toolchain.js";
import { checkSetupWorktrunk } from "./checks/worktrunk.js";
import { setupPresenter } from "./io.js";
import type {
  TextSetupSystemHint,
  TextSetupSystemRow,
  TextSetupSystemView,
} from "./presenters/text.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupCommandResult } from "./types.js";

export async function runSetupSystemCommand(
  args: { check: boolean; yes: boolean; noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  const initial = await collectSystemFacts(args, options, deps);
  const presenter = setupPresenter(deps);
  await presenter.write(
    presenter.renderSystemStatus(projectSystemView(setupMessageRef("system.title"), initial)),
  );

  let operationFailed = false;
  if (args.yes && initial.brew.status === "ok") {
    const operations: SetupToolInstallOperation[] = [];
    if (initial.worktrunk.status === "missing")
      operations.push(systemInstallOperation("worktrunk"));
    if (initial.tmux.status === "missing") operations.push(systemInstallOperation("tmux"));
    if (!initial.compiled && initial.bun.status === "missing") {
      operations.push(systemInstallOperation("bun"));
    }
    if (initial.diffnav.status === "missing") operations.push(systemInstallOperation("diffnav"));
    if (initial.gitDelta.status === "missing") operations.push(systemInstallOperation("git-delta"));
    const executeOperation = createSetupOperationAdapter({ deps });
    // System prerequisites are ordered and fail-fast, so later installs never run after a required package failure.
    for (const operation of operations) {
      const progress = {
        label: systemToolInstallLabel({ operation, text: presenter.text }),
      };
      await presenter.write(`${presenter.renderProgressStart(progress)}\n`);
      const outcome = await executeOperation(operation);
      if (outcome.status === "failed") {
        operationFailed = true;
        await presenter.write(`${presenter.renderProgressFailure(progress, outcome.error)}\n`);
        await presenter.writeMessage(setupMessageRef("system.install-failed"));
        break;
      }
      await presenter.write(`${presenter.renderProgressComplete(progress)}\n`);
    }
  }

  if (!args.yes) {
    return { code: systemReady(initial) ? 0 : 1 };
  }

  const refreshed = await collectSystemFacts(args, options, deps);
  await presenter.write(
    presenter.renderSystemStatus(
      projectSystemView(setupMessageRef("system.final-title"), refreshed),
    ),
  );
  return { code: !operationFailed && systemReady(refreshed) ? 0 : 1 };
}

type SystemFacts = {
  compiled: boolean;
  worktrunk: Awaited<ReturnType<typeof checkSetupWorktrunk>>;
  tmux: Awaited<ReturnType<typeof checkSetupTmux>>;
  bun: Awaited<ReturnType<typeof checkSetupBun>>;
  diffnav: Awaited<ReturnType<typeof checkSetupDiffnav>>;
  gitDelta: Awaited<ReturnType<typeof checkSetupGitDelta>>;
  brew: Awaited<ReturnType<typeof checkBrewDependency>>;
  toolchain: Awaited<ReturnType<typeof checkSetupToolchain>>;
};

async function collectSystemFacts(
  args: { noBrew: boolean },
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SystemFacts> {
  const env = deps.env ?? options.env;
  const compiled = deps.compiled ?? isCompiledBinary();
  const dependencyOptions = dependencyOptionsForCommand(deps, env);
  const [worktrunk, tmux, bun, diffnav, gitDelta, brew, toolchain] = await Promise.all([
    checkSetupWorktrunk(dependencyOptions),
    checkSetupTmux(dependencyOptions),
    compiled
      ? Promise.resolve({ status: "ok" as const, command: "bun" })
      : checkSetupBun(dependencyOptions),
    checkSetupDiffnav(dependencyOptions),
    checkSetupGitDelta(dependencyOptions),
    checkBrewDependency({
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(env === undefined ? {} : { env }),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      noBrew: args.noBrew,
    }),
    checkSetupToolchain({
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(env === undefined ? {} : { env }),
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.nodeVersion === undefined ? {} : { nodeVersion: deps.nodeVersion }),
    }),
  ]);
  return { compiled, worktrunk, tmux, bun, diffnav, gitDelta, brew, toolchain };
}

function projectSystemView(
  title: TextSetupSystemView["title"],
  facts: SystemFacts,
): TextSetupSystemView {
  const rows: TextSetupSystemRow[] = [
    dependencySystemRow(facts.worktrunk.status, setupMessageRef("label.worktrunk")),
    dependencySystemRow(facts.tmux.status, setupMessageRef("label.tmux")),
    ...(facts.compiled
      ? []
      : [dependencySystemRow(facts.bun.status, setupMessageRef("label.bun"))]),
    dependencySystemRow(facts.diffnav.status, setupMessageRef("label.diffnav")),
    dependencySystemRow(facts.gitDelta.status, setupMessageRef("label.git-delta")),
    {
      status: facts.brew.status === "ok" ? "ok" : facts.brew.status,
      label: setupMessageRef("label.homebrew"),
    },
    toolchainSystemRow(facts.toolchain.node, setupMessageRef("label.node")),
    toolchainSystemRow(facts.toolchain.pnpm, setupMessageRef("label.pnpm")),
  ];
  return { title, rows, hints: runtimeToolchainHints(facts.toolchain) };
}

function dependencySystemRow(
  status: "ok" | "missing",
  label: TextSetupSystemRow["label"],
): TextSetupSystemRow {
  return { status, label };
}

function toolchainSystemRow(
  fact: ToolchainFact,
  label: TextSetupSystemRow["label"],
): TextSetupSystemRow {
  return {
    status: fact.status === "ok" ? "ok" : "warning",
    label,
    detail: `${toolchainStatusLabel(fact)} ${toolchainVersionLabel(fact)}`,
  };
}

function systemReady(facts: SystemFacts): boolean {
  return (
    facts.worktrunk.status === "ok" &&
    facts.tmux.status === "ok" &&
    (facts.compiled || facts.bun.status === "ok") &&
    facts.diffnav.status === "ok" &&
    facts.gitDelta.status === "ok" &&
    facts.toolchain.node.status === "ok" &&
    facts.toolchain.pnpm.status === "ok"
  );
}

function systemInstallOperation(
  tool: SetupToolInstallOperation["tool"],
): SetupToolInstallOperation {
  return {
    id: `install:${tool}`,
    kind: "install-tool",
    tier: "required",
    selected: true,
    tool,
  };
}

function systemToolInstallLabel(input: {
  readonly operation: SetupToolInstallOperation;
  readonly text: (reference: ReturnType<typeof setupMessageRef>) => string;
}): string {
  const { operation, text } = input;
  const label =
    operation.tool === "worktrunk"
      ? setupMessageRef("label.worktrunk")
      : operation.tool === "tmux"
        ? setupMessageRef("label.tmux")
        : operation.tool === "bun"
          ? setupMessageRef("label.bun")
          : operation.tool === "diffnav"
            ? setupMessageRef("label.diffnav")
            : setupMessageRef("label.git-delta");
  return text(
    setupMessageRef("action.install-label", {
      label: resolveSetupMessage(label),
    }),
  );
}

function dependencyOptionsForCommand(
  deps: SetupCommandDeps,
  env: CliEnv | undefined,
): SetupDependencyCheckOptions {
  const dependencyOptions: SetupDependencyCheckOptions = {};
  if (env !== undefined) dependencyOptions.env = env;
  if (deps.runner !== undefined) dependencyOptions.runner = deps.runner;
  if (deps.access !== undefined) dependencyOptions.access = deps.access;
  return dependencyOptions;
}

function toolchainStatusLabel(fact: ToolchainFact): string {
  return fact.status === "ok" ? "ok" : fact.status;
}

function toolchainVersionLabel(fact: ToolchainFact): string {
  const actual = fact.actual ?? "not found";
  return `${actual} (expected ${fact.expected})`;
}

function runtimeToolchainHints(toolchain: {
  node: ToolchainFact;
  pnpm: ToolchainFact;
}): TextSetupSystemHint[] {
  const hints: TextSetupSystemHint[] = [];
  if (toolchain.node.status !== "ok") {
    hints.push({
      message: setupMessageRef("system.node-hint"),
      commandSequences: [
        [
          ["fnm", "install", "24"],
          ["fnm", "use", "24"],
        ],
        [
          ["nvm", "install", "24"],
          ["nvm", "use", "24"],
        ],
      ],
    });
  }
  if (toolchain.pnpm.status !== "ok") {
    hints.push({
      message: setupMessageRef("system.pnpm-hint"),
      commands: [
        ["corepack", "enable"],
        ["corepack", "prepare", "pnpm@11.0.0", "--activate"],
      ],
    });
  }
  if (hints.length > 0) {
    hints.push({ message: setupMessageRef("system.unchanged-hint") });
  }
  return hints;
}
